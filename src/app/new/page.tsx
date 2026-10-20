'use client'
import { apiFetch } from '@/lib/api-client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { addWeeks, getWeek, getYear, subWeeks } from 'date-fns'
import { ArrowLeft, Briefcase, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, User } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getWeekRange, formatDate } from '@/lib/utils'
import { formatSystemDate } from '@/lib/time-format'

type AudienceVariant = 'leadership' | 'personal'
type PreviewVariant = { variant: AudienceVariant; sourceDraft: string }

const variantLabels: Record<AudienceVariant, string> = {
  leadership: 'Leadership',
  personal: 'Personal',
}

export default function NewReportPage() {
  const router = useRouter()
  const [baseDate, setBaseDate] = useState<Date | null>(null)
  const [preview, setPreview] = useState<PreviewVariant[] | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewRequestVersion, setPreviewRequestVersion] = useState(0)
  const [previewVariant, setPreviewVariant] = useState<AudienceVariant>('leadership')
  const [saving, setSaving] = useState(false)

  const { start, end } = getWeekRange(baseDate ?? new Date(0))
  const weekStart = formatDate(start)
  const weekEnd = formatDate(end)
  const displayWeekStart = formatSystemDate(`${weekStart}T00:00:00`)
  const displayWeekEnd = formatSystemDate(`${weekEnd}T00:00:00`)
  const year = getYear(baseDate ?? new Date(0))
  const weekNumber = getWeek(baseDate ?? new Date(0), { weekStartsOn: 1 })
  const [title, setTitle] = useState('')

  useEffect(() => {
    const now = new Date()
    setBaseDate(now)
    setTitle(`${getYear(now)} Week ${getWeek(now, { weekStartsOn: 1 })} Work Report`)
  }, [])

  function changeWeek(nextDate: Date) {
    setBaseDate(nextDate)
    setTitle(`${getYear(nextDate)} Week ${getWeek(nextDate, { weekStartsOn: 1 })} Work Report`)
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
          body: JSON.stringify({ weekStart, weekEnd }),
          signal: controller.signal,
        })
        const data = await response.json()
        if (!response.ok) {
          throw new Error(data.error || 'Preview failed')
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
  }, [baseDate, weekStart, weekEnd, previewRequestVersion])

  function refreshPreview() {
    setPreview(null)
    setPreviewError(null)
    setPreviewRequestVersion((version) => version + 1)
  }

  async function handleSave() {
    if (!title.trim()) {
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
        body: JSON.stringify({ title: title.trim(), weekStart, weekEnd }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Creation failed')
      }
      toast.success('Source draft created')
      router.push(`/reports/${data.report.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Creation failed. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const activePreview = preview?.find((item) => item.variant === previewVariant)?.sourceDraft ?? ''
  const previewing = preview === null && previewError === null

  if (!baseDate) {
    return <main className="container mx-auto max-w-4xl px-4 py-8">Loading...</main>
  }

  return (
    <main className="container mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.back()} aria-label="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">New Report</h1>
      </div>

      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <Button type="button" variant="outline" size="icon" onClick={() => changeWeek(subWeeks(baseDate, 1))} disabled={previewing || saving} aria-label="Previous week">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-center text-lg font-medium">
            <span suppressHydrationWarning>Week {weekNumber}, {year} ({displayWeekStart} – {displayWeekEnd})</span>
          </div>
          <Button type="button" variant="outline" size="icon" onClick={() => changeWeek(addWeeks(baseDate, 1))} disabled={previewing || saving} aria-label="Next week">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-2">
          <Label htmlFor="title">Title</Label>
          <Input id="title" value={title} onChange={(event) => setTitle(event.target.value)} disabled={saving} />
        </div>

        <section aria-label="Source draft preview" className="space-y-4 rounded-lg border border-border p-5">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-semibold">Source draft preview (read-only)</h2>
            {preview && (
              <Button type="button" variant="outline" onClick={refreshPreview} disabled={saving}>
                <RefreshCw className="mr-1.5 h-4 w-4" />
                Refresh
              </Button>
            )}
          </div>
          {previewing ? (
            <div role="status" className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              Loading source draft...
            </div>
          ) : previewError ? (
            <div role="alert" className="flex min-h-56 flex-col items-center justify-center gap-3 text-sm text-destructive">
              <p>{previewError}</p>
              <Button type="button" variant="outline" onClick={refreshPreview} disabled={saving}>
                <RefreshCw className="mr-1.5 h-4 w-4" />
                Retry
              </Button>
            </div>
          ) : preview ? (
            <Tabs value={previewVariant} onValueChange={(value) => setPreviewVariant(value as AudienceVariant)}>
              <TabsList className="w-full">
                <TabsTrigger value="leadership"><Briefcase className="h-4 w-4" />{variantLabels.leadership}</TabsTrigger>
                <TabsTrigger value="personal"><User className="h-4 w-4" />{variantLabels.personal}</TabsTrigger>
              </TabsList>
              <TabsContent value={previewVariant} className="mt-4">
                <div className="min-h-56 rounded-lg border border-border bg-muted/20 p-5 prose-report">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{activePreview}</ReactMarkdown>
                </div>
              </TabsContent>
            </Tabs>
          ) : null}
        </section>

        <div className="flex justify-end gap-4">
          <Button type="button" variant="outline" onClick={() => router.back()} disabled={previewing || saving}>Cancel</Button>
          <Button type="button" onClick={handleSave} disabled={previewing || saving || !preview}>
            {saving ? 'Creating...' : 'Create'}
          </Button>
        </div>
      </div>
    </main>
  )
}
