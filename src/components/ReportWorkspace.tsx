'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
  ArrowLeft,
  Briefcase,
  Download,
  FileText,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  User,
} from 'lucide-react'
import { toast } from 'sonner'
import { MilkdownEditor } from '@/components/editor/MilkdownEditor'
import { GenerationWorkspace } from '@/components/GenerationWorkspace'
import { ReportReviewGate } from '@/components/report/ReportReviewGate'
import type { AudienceVariant, FinalStatus, Report, ReportVariant } from '@/lib/db/schema'
import { EMPTY_SOURCE_DRAFT } from '@/lib/reports/source-draft'
import { formatSystemDate } from '@/lib/time-format'
import styles from '@/components/report/report-workspace.module.css'

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

type WorkspaceMode = 'content' | 'ai'
type ContentPane = 'final' | 'source' | 'compare' | 'edit'

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

const variantScopes: Record<AudienceVariant, string> = {
  leadership: 'Work + manual evidence',
  personal: 'All evidence',
}

function finalStatusText(hasFinal: boolean, status: FinalStatus): string {
  if (!hasFinal) return 'None'
  return status === 'stale' ? 'Stale' : 'Current'
}

function statusClass(hasFinal: boolean, status: FinalStatus): string {
  if (!hasFinal) return styles.statusNone
  return status === 'stale' ? styles.statusStale : styles.statusCurrent
}

function isAudienceVariant(value: unknown): value is AudienceVariant {
  return value === 'leadership' || value === 'personal'
}

export function ReportWorkspace({
  reportId,
  editable = true,
  initialAudience,
}: {
  reportId: number
  editable?: boolean
  /** Audience carried from the library preview (?audience=...). */
  initialAudience?: AudienceVariant
}) {
  const router = useRouter()
  const [bundle, setBundle] = useState<ReportBundle | null>(null)
  const [templates, setTemplates] = useState<TemplateOption[]>([])
  const [styleOptions, setStyles] = useState<StyleOption[]>([])
  const [variant, setVariant] = useState<AudienceVariant>(initialAudience ?? 'personal')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [editorKey, setEditorKey] = useState(0)
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(editable ? 'ai' : 'content')
  const [pane, setPane] = useState<ContentPane>('final')

  const currentVariant = useMemo(
    () => bundle?.variants.find((item) => item.variant === variant) ?? null,
    [bundle, variant],
  )
  const hasFinal = Boolean(currentVariant?.finalContent)
  const hasSource = Boolean(currentVariant?.sourceDraft)
  const finalStatus: FinalStatus = currentVariant?.finalStatus ?? 'none'
  const sourceRevision = currentVariant?.sourceRevision ?? 0

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [reportResponse, templateResponse, styleResponse] = await Promise.all([
          apiFetch(`/api/reports/${reportId}`),
          apiFetch('/api/templates'),
          apiFetch('/api/prompts/styles'),
        ])
        if (!reportResponse.ok) throw new Error('Report not found' + traceSuffix(reportResponse))
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
        // The library carries its selected audience in the URL. Honor it
        // exactly: a requested variant that is absent must surface as missing,
        // never be replaced by the other audience's content.
        const requestedAudience = isAudienceVariant(initialAudience)
          ? initialAudience
          : normalized.variants.find((item) => item.variant === 'personal')?.variant
            ?? normalized.variants[0]?.variant
            ?? 'personal'
        const initialVariant = normalized.variants.find((item) => item.variant === requestedAudience) ?? null
        setBundle(normalized)
        setVariant(requestedAudience)
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
  }, [reportId, initialAudience])

  function selectVariant(nextVariant: AudienceVariant) {
    const next = bundle?.variants.find((item) => item.variant === nextVariant)
    if (!next) return
    setVariant(nextVariant)
    setContent(next.finalContent ?? next.sourceDraft ?? '')
    setEditorKey((key) => key + 1)
    setPane('final')
  }

  function acceptGeneratedVariant(updated: ReportVariant) {
    setBundle((current) => current ? {
      ...current,
      variants: current.variants.map((item) => item.id === updated.id ? updated : item),
    } : current)
    setContent(updated.finalContent ?? updated.sourceDraft)
    setEditorKey((key) => key + 1)
    setPane('final')
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
      if (!response.ok) throw new Error((updated.error || 'Save failed') + traceSuffix(response))
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
      if (!response.ok) throw new Error((data.error || 'Failed to regenerate source draft') + traceSuffix(response))
      const normalized = normalizeBundle(data)
      const next = normalized.variants.find((item) => item.variant === variant)
      setBundle(normalized)
      setContent(next?.finalContent ?? next?.sourceDraft ?? '')
      setEditorKey((key) => key + 1)
      setPane('source')
      toast.success('Both source drafts updated. Create a new AI session.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to regenerate source draft')
    } finally {
      setBusy(null)
    }
  }

  function exportCurrent() {
    const exportContent = currentVariant?.finalContent ?? currentVariant?.sourceDraft ?? ''
    const exportKind = currentVariant?.finalContent ? 'final' : 'source-draft'
    const blob = new Blob([exportContent], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `weekly-report-${variantLabels[variant]}-${bundle?.weekStart ?? ''}-${exportKind}.md`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function deleteReport() {
    if (!confirm('Delete this report? Related AI sessions, messages, and proposals will also be deleted.')) return
    setBusy('delete')
    try {
      const response = await apiFetch(`/api/reports/${reportId}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Delete failed' + traceSuffix(response))
      toast.success('Report deleted')
      router.push('/reports')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Delete failed')
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className={styles.surface}>
        <div className={styles.statePanel} role="status">Loading report…</div>
      </div>
    )
  }
  if (!bundle) {
    return (
      <div className={styles.surface}>
        <div className={styles.errorPanel} role="alert">Report not found</div>
      </div>
    )
  }

  const periodLabel = `${formatSystemDate(`${bundle.weekStart}T00:00:00`)} – ${formatSystemDate(`${bundle.weekEnd}T00:00:00`)}`
  const availableVariant = bundle.variants[0]?.variant ?? null
  const audienceTabs = (
    <div className={styles.audienceTabs} role="group" aria-label="Report audience">
      {(['leadership', 'personal'] as AudienceVariant[]).map((item) => {
        const available = bundle.variants.some((candidate) => candidate.variant === item)
        const active = variant === item
        return (
          <button
            key={item}
            type="button"
            className={`${styles.audienceTab} ${active ? styles.audienceTabActive : ''}`}
            aria-pressed={active}
            onClick={() => selectVariant(item)}
            disabled={!available}
            title={available ? undefined : 'Legacy report has no version for this audience'}
          >
            {item === 'leadership'
              ? <Briefcase size={16} aria-hidden="true" />
              : <User size={16} aria-hidden="true" />}
            <span>
              <strong>{variantLabels[item]}</strong>
              <small>{variantScopes[item]}</small>
            </span>
          </button>
        )
      })}
    </div>
  )

  // A requested audience with no stored variant stays explicit. The other
  // audience's final is never rendered in its place.
  if (!currentVariant) {
    return (
      <div className={styles.surface}>
        <header className={styles.pageHeader}>
          <div className={styles.titleGroup}>
            <h1 className={styles.title}>{bundle.title}</h1>
            <p className={styles.description} suppressHydrationWarning>{periodLabel}</p>
          </div>
          <div className={styles.actions}>
            <Link href="/reports" className={styles.secondaryButton}>
              <ArrowLeft size={16} aria-hidden="true" />
              All reports
            </Link>
            {!editable && (
              <>
                <Link href={`/edit/${reportId}`} className={styles.primaryButton}>
                  <Pencil size={16} aria-hidden="true" />
                  Edit
                </Link>
                <button
                  type="button"
                  className={styles.dangerButton}
                  onClick={() => void deleteReport()}
                  disabled={busy !== null}
                >
                  <Trash2 size={16} aria-hidden="true" />
                  Delete
                </button>
              </>
            )}
          </div>
        </header>

        <div className={styles.workspaceBar}>{audienceTabs}</div>

        <div className={styles.noFinal} role="status">
          <FileText size={22} aria-hidden="true" />
          <h2>No {variantLabels[variant].toLowerCase()} version</h2>
          <p>
            This report has no {variantLabels[variant].toLowerCase()} audience variant. The other
            audience version is kept separate and is not shown here.
          </p>
          {availableVariant && (
            <div className={styles.noFinalActions}>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => selectVariant(availableVariant)}
              >
                <Plus size={16} aria-hidden="true" />
                Open {variantLabels[availableVariant]} version
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  const statusLabel = finalStatusText(hasFinal, finalStatus)

  return (
    <div className={styles.surface}>
      <header className={styles.pageHeader}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>{bundle.title}</h1>
          <p className={styles.description} suppressHydrationWarning>{periodLabel}</p>
          <div className={styles.metaStrip}>
            <span className={`${styles.statusBadge} ${statusClass(hasFinal, finalStatus)}`}>{statusLabel}</span>
            <span>
              {hasFinal
                ? finalStatus === 'stale'
                  ? 'Final version is stale'
                  : 'Final version available'
                : 'No final report'}
            </span>
            <span>Source revision r{sourceRevision}</span>
            <span>R{bundle.id}</span>
            {currentVariant.templateName && <span>{currentVariant.templateName}</span>}
          </div>
        </div>
        <div className={styles.actions}>
          <Link href="/reports" className={styles.secondaryButton}>
            <ArrowLeft size={16} aria-hidden="true" />
            All reports
          </Link>
          <button type="button" className={styles.secondaryButton} onClick={exportCurrent}>
            <Download size={16} aria-hidden="true" />
            Export
          </button>
          {editable ? (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void regenerateSources()}
              disabled={busy !== null}
            >
              <RefreshCw size={16} aria-hidden="true" />
              Regenerate source draft
            </button>
          ) : (
            <>
              <Link href={`/edit/${reportId}`} className={styles.primaryButton}>
                <Pencil size={16} aria-hidden="true" />
                Edit
              </Link>
              <button
                type="button"
                className={styles.dangerButton}
                onClick={() => void deleteReport()}
                disabled={busy !== null}
              >
                <Trash2 size={16} aria-hidden="true" />
                Delete
              </button>
            </>
          )}
        </div>
      </header>

      <div className={styles.workspaceBar}>
        {audienceTabs}
        <div className={styles.modeTabs} role="group" aria-label="Report workspace mode">
          <button
            type="button"
            className={`${styles.modeTab} ${workspaceMode === 'content' ? styles.modeTabActive : ''}`}
            aria-pressed={workspaceMode === 'content'}
            onClick={() => setWorkspaceMode('content')}
          >
            <FileText size={16} aria-hidden="true" />
            Report content
          </button>
          <button
            type="button"
            className={`${styles.modeTab} ${workspaceMode === 'ai' ? styles.modeTabActive : ''}`}
            aria-pressed={workspaceMode === 'ai'}
            onClick={() => setWorkspaceMode('ai')}
          >
            <MessageSquareText size={16} aria-hidden="true" />
            AI chat
          </button>
        </div>
      </div>

      {workspaceMode === 'ai' ? (
        <GenerationWorkspace
          key={`${reportId}-${variant}-${currentVariant.sourceRevision}`}
          reportId={reportId}
          variant={variant}
          reportVariant={currentVariant}
          templates={templates}
          styles={styleOptions}
          editable={editable}
          onAccepted={acceptGeneratedVariant}
        />
      ) : (
        <div className={styles.contentGrid}>
          <section className={styles.primaryColumn} aria-label={`${variantLabels[variant]} report review`}>
            <div className={styles.reviewSurface}>
              <div className={styles.paneBar}>
                <div className={styles.paneTabs} role="tablist" aria-label="Report review pane">
                  <PaneTab value="final" active={pane === 'final'} onSelect={setPane}>Final preview</PaneTab>
                  <PaneTab value="source" active={pane === 'source'} onSelect={setPane}>Source draft</PaneTab>
                  <PaneTab value="compare" active={pane === 'compare'} onSelect={setPane}>Compare</PaneTab>
                  {editable && hasFinal && (
                    <PaneTab value="edit" active={pane === 'edit'} onSelect={setPane}>Edit final</PaneTab>
                  )}
                </div>
                <span className={styles.paneMeta}>{variantLabels[variant]} · r{sourceRevision}</span>
              </div>

              <div hidden={pane !== 'final'}>
                <div className={styles.documentPanel}>
                  {hasFinal ? (
                    <>
                      <div className={styles.panelLabelRow}>
                        <h2 className={styles.panelTitle}>Final report</h2>
                        <span className={`${styles.statusBadge} ${statusClass(hasFinal, finalStatus)}`}>{statusLabel}</span>
                      </div>
                      {finalStatus === 'stale' && (
                        <div className={styles.staleNotice} role="status">
                          <AlertTriangle size={16} aria-hidden="true" />
                          <span>
                            The source draft was regenerated to revision r{sourceRevision}. This final still reflects an
                            earlier revision and is not current.
                          </span>
                        </div>
                      )}
                      <div className={styles.finalDocument}>
                        <div
                          data-testid="final-report-body"
                          className={styles.documentBody}
                        >
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentVariant.finalContent}</ReactMarkdown>
                        </div>
                      </div>
                      {editable && (
                        <div className={styles.inlineActions}>
                          <button type="button" className={styles.textButton} onClick={() => setPane('edit')}>
                            <Pencil size={15} aria-hidden="true" />
                            Edit final content
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className={styles.noFinal}>
                      <FileText size={22} aria-hidden="true" />
                      <h2>No final report yet</h2>
                      <p>
                        The source draft is a deterministic, read-only inventory of frozen evidence
                        for the {variantLabels[variant]} audience. It is not a candidate final.
                        {editable
                          ? ' Open AI generation to review a proposal before adoption.'
                          : ' No final has been adopted for this audience.'}
                      </p>
                      <div className={styles.noFinalActions}>
                        {editable && (
                          <button type="button" className={styles.primaryButton} onClick={() => setWorkspaceMode('ai')}>
                            <Plus size={16} aria-hidden="true" />
                            Open AI generation
                          </button>
                        )}
                        <button type="button" className={styles.textButton} onClick={() => setPane('source')}>
                          Inspect source draft
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div hidden={pane !== 'source'}>
                <div className={styles.documentPanel}>
                  <div className={styles.panelLabelRow}>
                    <h2 className={styles.panelTitle}>Source draft</h2>
                    <span className={styles.readOnlyBadge}>Read-only</span>
                  </div>
                  <p className={styles.panelDescription}>
                    Deterministic facts from the frozen {variantLabels[variant]} snapshot. This is the fact authority,
                    not a final.
                  </p>
                </div>
                <div
                  data-testid="source-draft-scroll"
                  className={`${styles.sourceScroll} ${styles.documentBody} overflow-y-auto max-h-[min(70vh,720px)]`}
                >
                  {hasSource
                    ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentVariant.sourceDraft}</ReactMarkdown>
                    : <p>No source draft has been generated for this audience.</p>}
                </div>
              </div>

              {pane === 'compare' && (
                <div className={styles.compareGrid}>
                  <section className={styles.comparePane} aria-label="Source draft comparison">
                    <div className={styles.panelLabelRow}>
                      <h2 className={styles.panelTitle}>Source draft</h2>
                      <span className={styles.readOnlyBadge}>Read-only</span>
                    </div>
                    <div className={`${styles.documentBody} ${styles.compareBody}`}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentVariant.sourceDraft}</ReactMarkdown>
                    </div>
                  </section>
                  <section className={styles.comparePane} aria-label="Final report comparison">
                    <div className={styles.panelLabelRow}>
                      <h2 className={styles.panelTitle}>Final report</h2>
                      <span className={`${styles.statusBadge} ${statusClass(hasFinal, finalStatus)}`}>{statusLabel}</span>
                    </div>
                    {hasFinal ? (
                      <div className={`${styles.documentBody} ${styles.compareBody}`}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentVariant.finalContent}</ReactMarkdown>
                      </div>
                    ) : (
                      <div className={styles.noFinalCompact}>
                        No final report yet. The source draft remains the fact authority and is not a candidate final.
                      </div>
                    )}
                  </section>
                </div>
              )}

              {pane === 'edit' && editable && hasFinal && (
                <div>
                  <div className={styles.editToolbar}>
                    <div className={styles.editToolbarTitle}>
                      <h2>Edit final content</h2>
                      <p>Saving updates the current final for {variantLabels[variant]} at source revision r{sourceRevision}.</p>
                    </div>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      onClick={() => void saveEditedFinal()}
                      disabled={busy !== null}
                    >
                      <Save size={16} aria-hidden="true" />
                      Save
                    </button>
                  </div>
                  <div className={styles.editorShell}>
                    <MilkdownEditor key={editorKey} value={content} onChange={setContent} />
                  </div>
                </div>
              )}
            </div>
          </section>

          <div className={styles.contextColumn}>
            <ReportReviewGate
              audience={variant}
              sourceRevision={sourceRevision}
              snapshotCount={bundle.snapshots.length}
              sourceDraft={currentVariant.sourceDraft}
              hasFinal={hasFinal}
              finalStatus={finalStatus}
              acceptedProposalId={currentVariant.acceptedProposalId}
              templateName={currentVariant.templateName}
              aiStyle={currentVariant.aiStyle}
              editable={editable}
              onOpenGeneration={() => setWorkspaceMode('ai')}
              onEditFinal={() => setPane('edit')}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function PaneTab({
  value,
  active,
  onSelect,
  children,
}: {
  value: ContentPane
  active: boolean
  onSelect: (value: ContentPane) => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`${styles.paneTab} ${active ? styles.paneTabActive : ''}`}
      onClick={() => onSelect(value)}
    >
      {children}
    </button>
  )
}
