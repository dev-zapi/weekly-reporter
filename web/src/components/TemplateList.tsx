import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { TemplateTabs } from '@/components/TemplateTabs'
import { CloneTemplateDialog } from '@/components/CloneTemplateDialog'
import { ViewTemplateDialog } from '@/components/ViewTemplateDialog'
import { apiFetch, traceSuffix } from '@/lib/api-client'
import type { OfficialTemplate } from '@/lib/official-templates'
import type { Template } from '@/lib/db/schema'
import styles from './library-configuration.module.css'

interface TemplateListProps {
  onSelect?: (template: Template) => void
}

async function listError(response: Response) {
  try {
    const data = await response.json()
    return `${data.error || 'Failed to load templates'}${traceSuffix(response)}`
  } catch {
    return `Failed to load templates${traceSuffix(response)}`
  }
}

export function TemplateList({ onSelect }: TemplateListProps) {
  const navigate = useNavigate()
  const [officialTemplates, setOfficialTemplates] = useState<OfficialTemplate[]>([])
  const [userTemplates, setUserTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [selectedTemplateForSaveAs, setSelectedTemplateForSaveAs] = useState<OfficialTemplate | Template | null>(null)
  const [selectedTemplateForView, setSelectedTemplateForView] = useState<OfficialTemplate | null>(null)
  const [saveAsDialogOpen, setSaveAsDialogOpen] = useState(false)
  const [viewDialogOpen, setViewDialogOpen] = useState(false)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const response = await apiFetch('/api/templates')
        if (!response.ok) throw new Error(await listError(response))
        const data = await response.json()
        if (cancelled) return
        setOfficialTemplates(data.official || [])
        setUserTemplates(data.user || [])
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : 'Failed to load templates'
        setLoadError(message)
        toast.error(message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [reloadToken])

  async function handleClone(templateId: string) {
    try {
      const response = await apiFetch('/api/templates/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: templateId }),
      })

      if (response.ok) {
        const data = await response.json()
        toast.success('Template cloned')
        navigate(`/templates/${data.template.id}`)
      } else {
        const error = await response.json()
        toast.error((error.error || 'Clone failed') + traceSuffix(response))
      }
    } catch {
      toast.error('Clone failed')
    }
  }

  function handleSaveAs(templateId: string) {
    const template = officialTemplates.find((item) => item.id === templateId)
      || userTemplates.find((item) => `user-${item.id}` === templateId)

    if (template) {
      setSelectedTemplateForSaveAs(template)
      setSaveAsDialogOpen(true)
    }
  }

  function handleView(templateId: string) {
    const template = officialTemplates.find((item) => item.id === templateId)

    if (template) {
      setSelectedTemplateForView(template)
      setViewDialogOpen(true)
    }
  }

  async function handleCloneWithEdit(data: { sourceId: string; name: string; content: string }) {
    let response: Response
    try {
      response = await apiFetch('/api/templates/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
    } catch {
      throw new Error('Save failed')
    }

    if (!response.ok) {
      let message = `Save failed${traceSuffix(response)}`
      try {
        const error = await response.json()
        message = `${error.error || 'Save failed'}${traceSuffix(response)}`
      } catch {
        // Keep the fallback and trace when the server did not return JSON.
      }
      throw new Error(message)
    }

    const result = await response.json()
    toast.success('Template saved')
    navigate(`/templates/${result.template.id}`)
    setReloadToken((token) => token + 1)
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this template?')) return

    try {
      const response = await apiFetch(`/api/templates/${id}`, { method: 'DELETE' })
      if (response.ok) {
        setUserTemplates((current) => current.filter((template) => template.id !== id))
        toast.success('Template deleted')
      } else {
        const error = await response.json()
        toast.error((error.error || 'Delete failed') + traceSuffix(response))
      }
    } catch {
      toast.error('Delete failed')
    }
  }

  if (loading) {
    return (
      <div className={styles.loadingState} role="status">
        <span className={styles.loadingLine} aria-hidden="true" />
        <strong>Loading template library…</strong>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className={styles.errorState} role="alert">
        <strong>Templates could not be loaded</strong>
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
          Retry loading templates
        </button>
      </div>
    )
  }

  return (
    <>
      <TemplateTabs
        officialTemplates={officialTemplates}
        userTemplates={userTemplates}
        onCloneOfficial={handleClone}
        onSaveAsOfficial={handleSaveAs}
        onViewOfficial={handleView}
        onDeleteUser={handleDelete}
        onSelectUser={onSelect}
      />

      <CloneTemplateDialog
        template={selectedTemplateForSaveAs}
        open={saveAsDialogOpen}
        onClose={() => setSaveAsDialogOpen(false)}
        onClone={handleCloneWithEdit}
      />

      <ViewTemplateDialog
        template={selectedTemplateForView}
        open={viewDialogOpen}
        onClose={() => setViewDialogOpen(false)}
      />
    </>
  )
}
