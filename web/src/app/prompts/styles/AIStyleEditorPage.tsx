import { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'
import type { AIStyleRow } from '@/lib/db/schema'
import type { StyleFormData } from '@/lib/ai-style-drafts'
import { apiFetch, traceSuffix } from '@/lib/api-client'
import { AIStyleForm } from '@/components/AIStyleForm'
import styles from '@/components/library-configuration.module.css'

async function apiError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json()
    return `${data.error || fallback}${traceSuffix(response)}`
  } catch {
    return `${fallback}${traceSuffix(response)}`
  }
}

export function AIStyleEditorPage({ isNew }: { isNew: boolean }) {
  const params = useParams()
  const id = params.id
  const [style, setStyle] = useState<AIStyleRow | null>(null)
  const [loading, setLoading] = useState(!isNew)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (isNew || !id) return
    let cancelled = false

    void (async () => {
      try {
        const response = await apiFetch(`/api/prompts/styles/${id}`)
        if (response.status === 404) {
          if (!cancelled) setNotFound(true)
          return
        }
        if (!response.ok) throw new Error(await apiError(response, 'Failed to load style'))
        const data = await response.json()
        if (!cancelled) setStyle(data.style)
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : 'Failed to load style'
        setLoadError(message)
        toast.error(message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [id, isNew, reloadToken])

  async function save(form: StyleFormData): Promise<number> {
    let response: Response
    try {
      response = await apiFetch(isNew ? '/api/prompts/styles' : `/api/prompts/styles/${id}`, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
    } catch {
      toast.error('Operation failed. Check the service connection and retry.')
      throw new Error('Network failure')
    }

    if (!response.ok) {
      const message = await apiError(response, isNew ? 'Creation failed' : 'Update failed')
      toast.error(message)
      throw new Error(message)
    }
    const data = await response.json()
    return data.style.id
  }

  if (isNew) return <AIStyleForm key="new" isNew onSave={save} />
  if (!loading && !notFound && !loadError && style) {
    return <AIStyleForm key={style.id} style={style} isNew={false} onSave={save} />
  }

  return (
    <section className={styles.surface} aria-labelledby="ai-style-editor-state-title">
      <Link to={style ? `/prompts?tab=styles&style=${style.id}` : '/prompts?tab=styles'} className={styles.backLink}>
        <ArrowLeft size={14} aria-hidden="true" /> Back to AI styles
      </Link>
      <header className={styles.pageHeading}>
        <div className={styles.headingText}>
          <div className={styles.titleRow}>
            <h1 id="ai-style-editor-state-title">Edit AI style</h1>
            {id && <span className={styles.recordRef}>S{id}</span>}
          </div>
        </div>
      </header>
      {loading ? (
        <div className={styles.loadingState} role="status">
          <span className={styles.loadingLine} aria-hidden="true" />
          <strong>Loading AI style…</strong>
        </div>
      ) : notFound ? (
        <div className={styles.emptyState}>
          <strong>AI style not found</strong>
          <p>The style may have been deleted. Return to the style index and choose an available record.</p>
          <Link to="/prompts?tab=styles" className={styles.secondaryButton}>Return to style index</Link>
        </div>
      ) : loadError ? (
        <div className={styles.errorState} role="alert">
          <strong>AI style could not be loaded</strong>
          <p>{loadError}</p>
          <button type="button" className={styles.stateAction} onClick={() => {
            setLoading(true)
            setLoadError(null)
            setReloadToken((token) => token + 1)
          }}>Retry loading style</button>
        </div>
      ) : null}
    </section>
  )
}
