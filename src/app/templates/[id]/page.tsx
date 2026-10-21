'use client'
import { apiFetch } from '@/lib/api-client'

import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { TemplateForm } from '@/components/TemplateForm'
import { StyleSelector } from '@/components/StyleSelector'
import { toast } from 'sonner'
import type { Template, AIStyle } from '@/lib/db/schema'

export default function EditTemplatePage() {
  const router = useRouter()
  const params = useParams()
  const id = params.id as string

  const [template, setTemplate] = useState<Template | null>(null)
  const [loading, setLoading] = useState(true)
  const [aiStyle, setAiStyle] = useState<AIStyle>('formal')

  useEffect(() => {
    fetchTemplate()
  }, [id])

  async function fetchTemplate() {
    try {
      const response = await apiFetch(`/api/templates/${id}`)
      if (response.ok) {
        const data = await response.json()
        setTemplate(data.template)
        setAiStyle(data.template.aiStyle || 'formal')
      } else {
        toast.error('Template not found')
        router.push('/templates')
      }
    } catch (error) {
      toast.error('Failed to load template')
      router.push('/templates')
    } finally {
      setLoading(false)
    }
  }

  async function handleStyleChange(style: AIStyle) {
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
        toast.error(error.error || 'Update failed')
        // Revert to previous style
        if (template) {
          setAiStyle(template.aiStyle || 'formal')
        }
      }
    } catch (error) {
      toast.error('Update failed')
      // Revert to previous style
      if (template) {
        setAiStyle(template.aiStyle || 'formal')
      }
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
      toast.error(error.error || 'Update failed')
      throw new Error('Update failed')
    }
  }

  if (loading) {
    return (
      <main className="container mx-auto py-8 px-4 max-w-3xl">
        <div className="text-center py-8">Loading...</div>
      </main>
    )
  }

  if (!template) {
    return null
  }

  return (
    <main className="container mx-auto py-8 px-4 max-w-3xl">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/templates">
          <Button variant="ghost" size="icon">←</Button>
        </Link>
        <h1 className="text-2xl font-bold">Edit Template</h1>
      </div>

      <div className="space-y-6">
        {/* AI Style Selector */}
        <div className="bg-card border rounded-lg p-4">
          <StyleSelector
            value={aiStyle}
            onChange={handleStyleChange}
          />
        </div>

        {/* Template Form */}
        <TemplateForm 
          template={template} 
          onSave={handleSave} 
          onCancel={() => router.push('/templates')} 
        />
      </div>
    </main>
  )
}
