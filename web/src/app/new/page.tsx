import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router'
import { addWeeks, getWeek, getYear, subWeeks } from 'date-fns'
import { ArrowLeft, Briefcase, ChevronLeft, ChevronRight, FileText, RefreshCw, User } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { apiFetch, traceSuffix } from '@/lib/api-client'
import { formatSystemDate, formatSystemInstant } from '@/lib/time-format'
import { formatDate, getWeekRange } from '@/lib/utils'
import styles from './new-report.module.css'

type AudienceVariant = 'leadership' | 'personal'
type PreviewVariant = { variant: AudienceVariant; sourceDraft: string }

const variantLabels: Record<AudienceVariant, string> = {
  leadership: 'Leadership',
  personal: 'Personal',
}

const variantScopes: Record<AudienceVariant, string> = {
  leadership: 'Work + manual evidence',
  personal: 'All evidence',
}

const subscribeToClientDate = () => () => {}
const getClientDateSnapshot = () => formatDate(new Date())
const getServerDateSnapshot = () => ''

export default function NewReportPage() {
  const navigate = useNavigate()
  const clientDateKey = useSyncExternalStore(subscribeToClientDate, getClientDateSnapshot, getServerDateSnapshot)
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)
  const initialDate = useMemo(
    () => clientDateKey ? new Date(`${clientDateKey}T12:00:00`) : null,
    [clientDateKey],
  )
  const baseDate = selectedDate ?? initialDate
  const [preview, setPreview] = useState<PreviewVariant[] | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewRequestVersion, setPreviewRequestVersion] = useState(0)
  const [previewVariant, setPreviewVariant] = useState<AudienceVariant>('leadership')
  const [saving, setSaving] = useState(false)
  const [titleError, setTitleError] = useState<string | null>(null)

  const { start, end } = getWeekRange(baseDate ?? new Date(0))
  const weekStart = formatDate(start)
  const weekEnd = formatDate(end)
  // The wire takes the browser-zone midnight with its offset; the stored period
  // key stays date-only, so the display values above are unchanged.
  const weekStartInstant = formatSystemInstant(start)
  const weekEndInstant = formatSystemInstant(end)
  const displayWeekStart = baseDate ? formatSystemDate(`${weekStart}T00:00:00`) : '—'
  const displayWeekEnd = baseDate ? formatSystemDate(`${weekEnd}T00:00:00`) : '—'
  const year = getYear(baseDate ?? new Date(0))
  const weekNumber = getWeek(baseDate ?? new Date(0), { weekStartsOn: 1 })
  const [titleOverride, setTitleOverride] = useState<string | null>(null)
  const title = titleOverride ?? (baseDate
    ? `${getYear(baseDate)} Week ${getWeek(baseDate, { weekStartsOn: 1 })} Work Report`
    : '')

  function changeWeek(nextDate: Date) {
    setSelectedDate(nextDate)
    setTitleOverride(null)
    setTitleError(null)
    setPreview(null)
    setPreviewError(null)
    setPreviewVariant('leadership')
  }

  useEffect(() => {
    const controller = new AbortController()

    async function loadPreview() {
      if (!baseDate) return
      try {
        const response = await apiFetch('/api/reports/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ weekStart: weekStartInstant, weekEnd: weekEndInstant }),
          signal: controller.signal,
        })
        const data = await response.json()
        if (!response.ok) {
          throw new Error((data.error || 'Preview failed') + traceSuffix(response))
        }
        if (!controller.signal.aborted) {
          setPreview(data.variants as PreviewVariant[])
          setPreviewVariant('leadership')
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setPreviewError(error instanceof Error ? error.message : 'Preview failed. Please try again.')
        }
      }
    }

    void loadPreview()
    return () => controller.abort()
  }, [baseDate, weekStart, weekEnd, weekStartInstant, weekEndInstant, previewRequestVersion])

  function refreshPreview() {
    setPreview(null)
    setPreviewError(null)
    setPreviewRequestVersion((version) => version + 1)
  }

  async function handleSave() {
    if (!title.trim()) {
      setTitleError('Please enter a title')
      toast.error('Please enter a title')
      return
    }
    if (!preview) {
      toast.error('Source draft preview is not ready')
      return
    }

    setSaving(true)
    try {
      const response = await apiFetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), weekStart: weekStartInstant, weekEnd: weekEndInstant }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error((data.error || 'Creation failed') + traceSuffix(response))
      }
      toast.success('Source draft created')
      // Keep the audience the user was previewing so the workspace does not
      // silently reopen the other audience's version.
      navigate(`/reports/${data.report.id}?audience=${previewVariant}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Creation failed. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const activePreview = preview?.find((item) => item.variant === previewVariant)?.sourceDraft ?? ''
  const initializing = baseDate === null
  const previewing = initializing || (preview === null && previewError === null)
  const previewStatus = saving ? 'Creating report' : previewing ? 'Loading draft' : previewError ? 'Preview unavailable' : 'Ready to create'

  return (
    <div className={styles.surface}>
      <section className={styles.primary} aria-labelledby="new-report-title">
        <header className={styles.pageHeader}>
          <div className={styles.titleGroup}>
            <h1 id="new-report-title">New Report</h1>
            <p>Choose a week, inspect both deterministic source drafts, then create the report for review.</p>
          </div>
          <button type="button" className={styles.secondaryButton} onClick={() => navigate(-1)} aria-label="Back">
            <ArrowLeft size={16} aria-hidden="true" />
            Back
          </button>
        </header>

        <section className={styles.previewPanel} aria-label="Source draft preview" aria-busy={previewing || saving}>
          <div className={styles.previewHeader}>
            <div>
              <h2>Source draft preview (read-only)</h2>
              <p>Frozen evidence becomes the report basis only after creation.</p>
            </div>
            <div className={styles.previewActions}>
              <span className={styles.statusBadge} data-state={previewError ? 'error' : previewing || saving ? 'pending' : 'ready'}>
                {previewStatus}
              </span>
              {preview && (
                <button type="button" className={styles.iconTextButton} onClick={refreshPreview} disabled={saving}>
                  <RefreshCw size={15} aria-hidden="true" />
                  Refresh
                </button>
              )}
            </div>
          </div>

          {previewing ? (
            <div role="status" className={styles.loadingState}>
              <span className={styles.loadingLine} aria-hidden="true" />
              <strong>Loading source draft...</strong>
              <p>Preparing separate Leadership and Personal evidence previews.</p>
            </div>
          ) : previewError ? (
            <div role="alert" className={styles.errorState}>
              <strong>Source draft could not load</strong>
              <p>{previewError}</p>
              <button type="button" className={styles.secondaryButton} onClick={refreshPreview} disabled={saving}>
                <RefreshCw size={15} aria-hidden="true" />
                Retry
              </button>
            </div>
          ) : preview ? (
            <Tabs
              className={styles.tabsRoot}
              value={previewVariant}
              onValueChange={(value) => setPreviewVariant(value as AudienceVariant)}
            >
              <TabsList className={styles.audienceTabs} aria-label="Source draft audience">
                <TabsTrigger className={styles.audienceTab} value="leadership">
                  <Briefcase size={16} aria-hidden="true" />
                  <span>
                    <strong>{variantLabels.leadership}</strong>
                    <small>{variantScopes.leadership}</small>
                  </span>
                </TabsTrigger>
                <TabsTrigger className={styles.audienceTab} value="personal">
                  <User size={16} aria-hidden="true" />
                  <span>
                    <strong>{variantLabels.personal}</strong>
                    <small>{variantScopes.personal}</small>
                  </span>
                </TabsTrigger>
              </TabsList>
              <TabsContent value={previewVariant} className={styles.previewContent}>
                {activePreview.trim() ? (
                  <div className={`prose-report read-only-prose ${styles.document}`}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{activePreview}</ReactMarkdown>
                  </div>
                ) : (
                  <div className={styles.emptyState}>
                    <FileText size={22} aria-hidden="true" />
                    <strong>No source draft entries</strong>
                    <p>
                      This audience has no evidence in the selected week. You can still create the report and review
                      its empty source draft.
                    </p>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          ) : null}
        </section>
      </section>

      <aside className={styles.context} aria-label="Report creation settings">
        <form
          className={styles.settingsPanel}
          aria-busy={saving}
          onSubmit={(event) => {
            event.preventDefault()
            void handleSave()
          }}
        >
          <section className={styles.settingSection} aria-labelledby="report-period-heading">
            <div className={styles.sectionHeading}>
              <h2 id="report-period-heading">Report period</h2>
              <span>Monday–Sunday</span>
            </div>
            <div className={styles.weekControl}>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => baseDate && changeWeek(subWeeks(baseDate, 1))}
                disabled={previewing || saving}
                aria-label="Previous week"
              >
                <ChevronLeft size={17} aria-hidden="true" />
              </button>
              <div className={styles.weekLabel} suppressHydrationWarning>
                <strong>{baseDate ? `Week ${weekNumber}, ${year}` : 'Loading week…'}</strong>
                <span>{displayWeekStart} – {displayWeekEnd}</span>
              </div>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => baseDate && changeWeek(addWeeks(baseDate, 1))}
                disabled={previewing || saving}
                aria-label="Next week"
              >
                <ChevronRight size={17} aria-hidden="true" />
              </button>
            </div>
          </section>

          <section className={styles.settingSection} aria-labelledby="report-title-heading">
            <div className={styles.sectionHeading}>
              <h2 id="report-title-heading">Report record</h2>
              <span>Required title</span>
            </div>
            <div className={styles.titleField}>
              <label htmlFor="title">Title</label>
              <input
                id="title"
                className={styles.titleInput}
                value={title}
                onChange={(event) => {
                  setTitleOverride(event.target.value)
                  if (titleError) setTitleError(null)
                }}
                disabled={initializing || saving}
                aria-required="true"
                aria-invalid={titleError ? true : undefined}
                aria-describedby={titleError ? 'title-error' : 'title-help'}
              />
              {titleError ? (
                <p id="title-error" className={styles.fieldError} role="alert">{titleError}</p>
              ) : (
                <p id="title-help" className={styles.fieldHelp}>Used to identify this report in the library.</p>
              )}
            </div>
          </section>

          <div className={styles.creationNote}>
            <h2>Source before final</h2>
            <p>Creation saves the selected week’s evidence snapshots and deterministic source drafts. No AI final is adopted here.</p>
          </div>

          <div className={styles.formActions}>
            <button type="submit" className={styles.primaryButton} disabled={previewing || saving || !preview}>
              {saving ? 'Creating...' : 'Create'}
            </button>
            <button type="button" className={styles.secondaryButton} onClick={() => navigate(-1)} disabled={previewing || saving}>
              Cancel
            </button>
            <p>Create opens the report with the {variantLabels[previewVariant]} audience selected.</p>
          </div>
        </form>
      </aside>
    </div>
  )
}
