'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { TemplateTabs } from '@/components/TemplateTabs'
import { CloneTemplateDialog } from '@/components/CloneTemplateDialog'
import { ViewTemplateDialog } from '@/components/ViewTemplateDialog'
import type { OfficialTemplate } from '@/lib/official-templates'
import type { Template } from '@/lib/db/schema'

interface TemplateListProps {
  onSelect?: (template: Template) => void
}

export function TemplateList({ onSelect }: TemplateListProps) {
  const router = useRouter()
  const [officialTemplates, setOfficialTemplates] = useState<OfficialTemplate[]>([])
  const [userTemplates, setUserTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTemplateForSaveAs, setSelectedTemplateForSaveAs] = useState<OfficialTemplate | Template | null>(null)
  const [selectedTemplateForView, setSelectedTemplateForView] = useState<OfficialTemplate | null>(null)
  const [saveAsDialogOpen, setSaveAsDialogOpen] = useState(false)
  const [viewDialogOpen, setViewDialogOpen] = useState(false)

  useEffect(() => {
    fetchTemplates()
  }, [])

  async function fetchTemplates() {
    try {
      const response = await apiFetch('/api/templates')
      const data = await response.json()
      setOfficialTemplates(data.official || [])
      setUserTemplates(data.user || [])
    } catch (error) {
      toast.error('Failed to load templates')
    } finally {
      setLoading(false)
    }
  }

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
        router.push(`/templates/${data.template.id}`)
      } else {
        const error = await response.json()
        toast.error((error.error || 'Clone failed') + traceSuffix(response))
      }
    } catch (error) {
      toast.error('Clone failed')
    }
  }

  function handleSaveAs(templateId: string) {
    const template = officialTemplates.find(t => t.id === templateId)
      || userTemplates.find(t => `user-${t.id}` === templateId)

    if (template) {
      setSelectedTemplateForSaveAs(template)
      setSaveAsDialogOpen(true)
    }
  }

  function handleView(templateId: string) {
    const template = officialTemplates.find(t => t.id === templateId)

    if (template) {
      setSelectedTemplateForView(template)
      setViewDialogOpen(true)
    }
  }

  async function handleCloneWithEdit(data: { sourceId: string; name: string; content: string }) {
    try {
      const response = await apiFetch('/api/templates/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (response.ok) {
        const result = await response.json()
        toast.success('Template saved')
        router.push(`/templates/${result.template.id}`)
        fetchTemplates() // 刷新列表
      } else {
        const error = await response.json()
        toast.error((error.error || 'Save failed') + traceSuffix(response))
      }
    } catch (error) {
      toast.error('Save failed')
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this template?')) return

    try {
      const response = await apiFetch(`/api/templates/${id}`, { method: 'DELETE' })
      if (response.ok) {
        setUserTemplates(userTemplates.filter((t) => t.id !== id))
        toast.success('Template deleted')
      } else {
        const error = await response.json()
        toast.error((error.error || 'Delete failed') + traceSuffix(response))
      }
    } catch (error) {
      toast.error('Delete failed')
    }
  }

  if (loading) {
    return <div className="text-center py-8">Loading...</div>
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
