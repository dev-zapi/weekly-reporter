'use client'
import { apiFetch } from '@/lib/api-client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowLeft, Briefcase, Download, FileText, MessageSquareText, RefreshCw, Save, Trash2, User } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { MilkdownEditor } from '@/components/editor/MilkdownEditor'
import { GenerationWorkspace } from '@/components/GenerationWorkspace'
import type { AudienceVariant, Report, ReportVariant } from '@/lib/db/schema'
import { EMPTY_SOURCE_DRAFT } from '@/lib/reports/source-draft'
import { formatSystemDate } from '@/lib/time-format'

interface TemplateOption {
  id: string
  name: string
  content: string
  aiStyle?: string
}

interface StyleOption {
  key: string
  label: string
}

interface ReportBundle extends Report {
  variants: ReportVariant[]
  snapshots: unknown[]
}

function normalizeBundle(data: Partial<ReportBundle> & { id: number; content?: string }): ReportBundle {
  const legacyVariant: ReportVariant = {
    id: -data.id,
    reportId: data.id,
    variant: 'personal',
    sourceDraft: EMPTY_SOURCE_DRAFT,
    finalContent: data.content ?? null,
    finalStatus: data.content ? 'current' : 'none',
    templateId: null,
    templateName: null,
    templateContent: null,
    structureCompletenessRule: null,
    aiStyle: null,
    acceptedProposalId: null,
    sourceRevision: 0,
    createdAt: data.createdAt ?? new Date(),
    updatedAt: data.updatedAt ?? new Date(),
  }
  return { ...data, variants: data.variants?.length ? data.variants : [legacyVariant], snapshots: data.snapshots ?? [] } as ReportBundle
}

const variantLabels: Record<AudienceVariant, string> = {
  personal: 'Personal',
  leadership: 'Leadership',
}

export function ReportWorkspace({ reportId, editable = true }: { reportId: number; editable?: boolean }) {
  const router = useRouter()
  const [bundle, setBundle] = useState<ReportBundle | null>(null)
  const [templates, setTemplates] = useState<TemplateOption[]>([])
  const [styles, setStyles] = useState<StyleOption[]>([])
  const [variant, setVariant] = useState<AudienceVariant>('personal')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [editorKey, setEditorKey] = useState(0)
  const [workspaceMode, setWorkspaceMode] = useState<'content' | 'ai'>(editable ? 'ai' : 'content')

  const currentVariant = useMemo(
    () => bundle?.variants.find((item) => item.variant === variant) ?? null,
    [bundle, variant],
  )
  const hasFinal = Boolean(currentVariant?.finalContent)
  const displayContent = currentVariant?.finalContent ?? currentVariant?.sourceDraft ?? ''

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [reportResponse, templateResponse, styleResponse] = await Promise.all([
          apiFetch(`/api/reports/${reportId}`),
          apiFetch('/api/templates'),
          apiFetch('/api/prompts/styles'),
        ])
        if (!reportResponse.ok) throw new Error('Report not found')
        const reportData = await reportResponse.json()
        const templateData = await templateResponse.json()
        const styleData = await styleResponse.json()
        if (cancelled) return

        const allTemplates = [
          ...(templateData.official ?? []),
          ...(templateData.user ?? []).map((item: { id: number; name: string; content: string; aiStyle?: string }) => ({
            ...item,
            id: `user-${item.id}`,
          })),
        ]
        const normalized = normalizeBundle(reportData)
        const initialVariant = normalized.variants.find((item) => item.variant === 'personal') ?? normalized.variants[0]
        setBundle(normalized)
        if (initialVariant) setVariant(initialVariant.variant)
        setContent(initialVariant?.finalContent ?? initialVariant?.sourceDraft ?? '')
        setTemplates(allTemplates)
        setStyles((styleData.styles ?? []).map((item: { key: string; label: string }) => ({ key: item.key, label: item.label })))
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to load report')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [reportId])

  function selectVariant(nextVariant: AudienceVariant) {
    const next = bundle?.variants.find((item) => item.variant === nextVariant)
    if (!next) return
    setVariant(nextVariant)
    setContent(next.finalContent ?? next.sourceDraft ?? '')
    setEditorKey((key) => key + 1)
  }

  function acceptGeneratedVariant(updated: ReportVariant) {
    setBundle((current) => current ? {
      ...current,
      variants: current.variants.map((item) => item.id === updated.id ? updated : item),
    } : current)
    setContent(updated.finalContent ?? updated.sourceDraft)
    setEditorKey((key) => key + 1)
  }

  async function saveEditedFinal() {
    if (!currentVariant?.finalContent || !content.trim()) return
    setBusy('save')
    try {
      const response = await apiFetch(`/api/reports/${reportId}/final`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variant,
          content,
          templateId: currentVariant.templateId,
          templateName: currentVariant.templateName,
          templateContent: currentVariant.templateContent,
          aiStyle: currentVariant.aiStyle,
          sourceRevision: currentVariant.sourceRevision,
        }),
      })
      const updated = await response.json()
      if (!response.ok) throw new Error(updated.error || 'Save failed')
      acceptGeneratedVariant(updated)
      toast.success('Final version saved')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed')
    } finally {
      setBusy(null)
    }
  }

  async function regenerateSources() {
    if (!confirm('Regenerating the source draft will invalidate the current final version and old AI session baseline. Continue?')) return
    setBusy('regenerate')
    try {
      const response = await apiFetch(`/api/reports/${reportId}/regenerate-source`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to regenerate source draft')
      const normalized = normalizeBundle(data)
      const next = normalized.variants.find((item) => item.variant === variant)
      setBundle(normalized)
      setContent(next?.finalContent ?? next?.sourceDraft ?? '')
      setEditorKey((key) => key + 1)
      toast.success('Both source drafts updated. Create a new AI session.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to regenerate source draft')
    } finally {
      setBusy(null)
    }
  }

  function exportCurrent() {
    const blob = new Blob([displayContent], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `weekly-report-${variantLabels[variant]}-${bundle?.weekStart ?? ''}.md`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function deleteReport() {
    if (!confirm('Delete this report? Related AI sessions, messages, and proposals will also be deleted.')) return
    setBusy('delete')
    try {
      const response = await apiFetch(`/api/reports/${reportId}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Delete failed')
      toast.success('Report deleted')
      router.push('/reports')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Delete failed')
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <div className="py-12 text-center">Loading...</div>
  if (!bundle || !currentVariant) return <div className="py-12 text-center">Report not found</div>

  return (
    <main className="container mx-auto max-w-[1500px] px-4 py-8">
      <div className="mb-6 flex items-start justify-between gap-4 max-[720px]:flex-col">
        <div className="flex items-start gap-3">
          <Link href="/reports"><Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button></Link>
          <div><h1 className="text-2xl font-bold">{bundle.title}</h1><p className="mt-1 text-sm text-muted-foreground" suppressHydrationWarning>{formatSystemDate(`${bundle.weekStart}T00:00:00`)} – {formatSystemDate(`${bundle.weekEnd}T00:00:00`)}</p></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={exportCurrent}><Download className="mr-1.5 h-4 w-4" />Export</Button>
          {editable && <Button variant="outline" onClick={() => void regenerateSources()} disabled={busy !== null}><RefreshCw className="mr-1.5 h-4 w-4" />Regenerate source draft</Button>}
          {!editable && <Link href={`/edit/${reportId}`}><Button>Edit</Button></Link>}
          {!editable && <Button variant="outline" className="text-destructive hover:bg-destructive/10" onClick={() => void deleteReport()} disabled={busy !== null}><Trash2 className="mr-1.5 h-4 w-4" />Delete</Button>}
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          {(['leadership', 'personal'] as AudienceVariant[]).map((item) => {
            const available = bundle.variants.some((candidate) => candidate.variant === item)
            return <Button key={item} variant={variant === item ? 'default' : 'outline'} onClick={() => selectVariant(item)} disabled={!available} title={available ? undefined : 'Legacy report has no version for this audience'}>
              {item === 'leadership' ? <Briefcase className="mr-1.5 h-4 w-4" /> : <User className="mr-1.5 h-4 w-4" />}{variantLabels[item]}
            </Button>
          })}
          <span className="ml-2 self-center text-sm text-muted-foreground">{hasFinal ? (currentVariant.finalStatus === 'stale' ? 'Final version is stale' : 'Final version available') : 'Source draft only'}</span>
        </div>
        <div className="flex rounded-lg bg-muted p-1">
          <button type="button" onClick={() => setWorkspaceMode('content')} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${workspaceMode === 'content' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}><FileText className="h-4 w-4" />Report content</button>
          <button type="button" onClick={() => setWorkspaceMode('ai')} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${workspaceMode === 'ai' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}><MessageSquareText className="h-4 w-4" />AI chat</button>
        </div>
      </div>

      {workspaceMode === 'ai' ? (
        <GenerationWorkspace
          key={`${reportId}-${variant}-${currentVariant.sourceRevision}`}
          reportId={reportId}
          variant={variant}
          reportVariant={currentVariant}
          templates={templates}
          styles={styles}
          editable={editable}
          onAccepted={acceptGeneratedVariant}
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="min-w-0 space-y-4">
            {editable && hasFinal ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between"><Label>Final version content</Label><Button size="sm" onClick={() => void saveEditedFinal()} disabled={busy !== null}><Save className="mr-1.5 h-4 w-4" />Save</Button></div>
                <MilkdownEditor key={editorKey} value={content} onChange={setContent} />
              </div>
            ) : (
              <div className={`rounded-xl border border-border p-6 prose prose-report max-w-none ${editable ? 'bg-[#141414] prose-invert' : 'report-view-content bg-card text-card-foreground'}`}>
                <div className="not-prose mb-4 flex items-center justify-between"><Label>{hasFinal ? 'Final version content' : 'Source draft (read-only)'}</Label>{hasFinal && currentVariant.finalStatus === 'stale' && <span className="text-xs text-amber-400">Source draft updated; final version is stale</span>}</div>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
              </div>
            )}
            {editable && !hasFinal && <div className="rounded-xl border border-border bg-muted/20 p-4 text-sm text-muted-foreground">This version has only a source draft. Switch to “AI chat” to create a session and ask AI to submit a proposed final version.</div>}
          </section>

          <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <div className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
              <p className="mb-2 font-medium text-foreground">Source draft</p>
              <div data-testid="source-draft-scroll" className="max-h-[min(42vh,440px)] overflow-y-auto rounded-lg border border-border bg-muted/20 p-3 pr-2 prose prose-sm dark:prose-invert prose-report max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentVariant.sourceDraft}</ReactMarkdown>
              </div>
            </div>
          </aside>
        </div>
      )}
    </main>
  )
}
