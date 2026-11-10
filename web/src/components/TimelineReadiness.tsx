import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { startOfDay } from 'date-fns'
import { Activity } from 'lucide-react'
import { getWeekPeriodRange, toOffsetInstant } from '@/lib/periods'
import { formatSystemInstant } from '@/lib/time-format'
import styles from './timeline.module.css'

type Audience = 'leadership' | 'personal'
type FinalStatus = 'none' | 'current' | 'stale'

interface ReportVariantRecord {
  variant: Audience | string
  sourceDraft?: string
  finalContent?: string | null
  finalStatus?: FinalStatus | string
  sourceRevision?: number
}

interface ReportRecord {
  id: number
  title: string
  weekStart: string
  weekEnd: string
  variants?: ReportVariantRecord[]
}

interface PlanItemRecord {
  status?: string
}

interface ReadinessCell {
  label: string
  value: ReactNode
  state: 'ready' | 'pending' | 'idle'
  note: string
}

const FINAL_STATUS_LABELS: Record<FinalStatus, string> = {
  current: 'Current',
  stale: 'Stale',
  none: 'Needed',
}

const FINAL_STATUS_CLASSES: Record<FinalStatus, string> = {
  current: styles.statusCurrent,
  stale: styles.statusStale,
  none: styles.statusNeeded,
}

function finalStatusOf(variant: ReportVariantRecord | undefined): FinalStatus {
  if (!variant) return 'none'
  if (variant.finalStatus === 'current' || variant.finalStatus === 'stale') {
    return variant.finalStatus
  }
  return 'none'
}

function revisionOf(variant: ReportVariantRecord | undefined): string {
  if (!variant || typeof variant.sourceRevision !== 'number') return 'None'
  return `R${variant.sourceRevision}`
}

function hasSourceDraft(variant: ReportVariantRecord | undefined): boolean {
  return !!variant && typeof variant.sourceDraft === 'string' && variant.sourceDraft.length > 0
}

/**
 * Read-only current-week readiness. The report lookup is scoped to this
 * natural week, so a report from an earlier week is never presented as this
 * week's source draft or final. Leadership and personal states stay separate.
 */
export function TimelineReadiness({
  eventsCount,
  refreshKey = 0,
}: {
  eventsCount: number
  refreshKey?: number
}) {
  const [planItems, setPlanItems] = useState<PlanItemRecord[]>([])
  const [report, setReport] = useState<ReportRecord | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    const now = new Date()
    // The plans date param is an RFC3339 instant in the browser's offset.
    const planDate = toOffsetInstant(startOfDay(now))
    const week = getWeekPeriodRange(now)
    // Reports search takes browser-zone midnights with an explicit offset; the
    // query string must be encoded so `+08:00` is not decoded as a space.
    const reportWindow = new URLSearchParams({
      startDate: formatSystemInstant(new Date(`${week.start}T00:00:00`)),
      endDate: formatSystemInstant(new Date(`${week.end}T00:00:00`)),
    }).toString()

    async function load() {
      setLoading(true)
      setPlanError(null)
      setReportError(null)

      // Wrap in Promise.resolve().then so a synchronously throwing fetch mock
      // (used by page-level tests) still becomes a settled result instead of an
      // unhandled rejection.
      const request = (path: string) =>
        Promise.resolve().then(() => apiFetch(path, { signal: controller.signal }))

      const [planResult, reportResult] = await Promise.allSettled([
        request(`/api/plans?scope=week&date=${encodeURIComponent(planDate)}`),
        request(`/api/reports/search?${reportWindow}`),
      ])

      if (controller.signal.aborted) return

      if (planResult.status === 'fulfilled') {
        const response = planResult.value
        if (!response.ok) {
          setPlanError(`Failed to load plan${traceSuffix(response)}`)
        } else {
          try {
            const payload = await response.json() as { items?: PlanItemRecord[]; error?: string }
            if (payload.error) {
              setPlanError(payload.error)
            } else {
              setPlanItems(Array.isArray(payload.items) ? payload.items : [])
            }
          } catch {
            setPlanError('Failed to read plan data')
          }
        }
      } else {
        setPlanError('Failed to load plan')
      }

      if (reportResult.status === 'fulfilled') {
        const response = reportResult.value
        if (!response.ok) {
          setReportError(`Failed to load report${traceSuffix(response)}`)
        } else {
          try {
            const payload = await response.json() as { reports?: ReportRecord[]; error?: string }
            if (payload.error) {
              setReportError(payload.error)
            } else {
              setReport(Array.isArray(payload.reports) ? payload.reports[0] ?? null : null)
            }
          } catch {
            setReportError('Failed to read report data')
          }
        }
      } else {
        setReportError('Failed to load report')
      }

      setLoading(false)
    }

    void load()
    return () => controller.abort()
  }, [refreshKey])

  const cells = useMemo<ReadinessCell[]>(() => {
    const totalPlans = planItems.length
    const donePlans = planItems.filter((item) => item.status === 'done').length

    const variants = report?.variants ?? []
    const leadership = variants.find((item) => item.variant === 'leadership')
    const personal = variants.find((item) => item.variant === 'personal')
    const reportHasVariants = variants.length > 0
    const anySourceDraft = hasSourceDraft(leadership) || hasSourceDraft(personal)

    const planValue = loading
      ? 'Loading…'
      : planError
        ? 'Unavailable'
        : totalPlans === 0
          ? 'No items'
          : `${donePlans}/${totalPlans} done`

    const planState: ReadinessCell['state'] = planError || totalPlans === 0
      ? 'idle'
      : donePlans === totalPlans
        ? 'ready'
        : 'pending'

    const sourceValue: ReactNode = loading
      ? 'Loading…'
      : reportError
        ? 'Unavailable'
        : !report
          ? 'Not created'
          : !reportHasVariants
            ? 'No snapshot'
            : (
              <span className={styles.dualStatus}>
                <span className={styles.dualStatusRow}>
                  <span>Lead</span>
                  <span>{revisionOf(leadership)}</span>
                </span>
                <span className={styles.dualStatusRow}>
                  <span>Personal</span>
                  <span>{revisionOf(personal)}</span>
                </span>
              </span>
            )

    const sourceState: ReadinessCell['state'] = anySourceDraft ? 'ready' : 'idle'

    const leadershipFinal = finalStatusOf(leadership)
    const personalFinal = finalStatusOf(personal)
    const bothCurrent = reportHasVariants
      && leadershipFinal === 'current'
      && personalFinal === 'current'

    const finalValue: ReactNode = loading
      ? 'Loading…'
      : reportError
        ? 'Unavailable'
        : !report
          ? 'Not created'
          : !reportHasVariants
            ? 'No snapshot'
            : (
              <span className={styles.dualStatus}>
                <span className={styles.dualStatusRow}>
                  <span>Lead</span>
                  <span className={FINAL_STATUS_CLASSES[leadershipFinal]}>
                    {FINAL_STATUS_LABELS[leadershipFinal]}
                  </span>
                </span>
                <span className={styles.dualStatusRow}>
                  <span>Personal</span>
                  <span className={FINAL_STATUS_CLASSES[personalFinal]}>
                    {FINAL_STATUS_LABELS[personalFinal]}
                  </span>
                </span>
              </span>
            )

    const finalState: ReadinessCell['state'] = !report || !reportHasVariants
      ? 'idle'
      : bothCurrent
        ? 'ready'
        : 'pending'

    return [
      {
        label: 'Work evidence',
        value: `${eventsCount} loaded`,
        state: eventsCount > 0 ? 'ready' : 'idle',
        note: 'Current view · live timeline',
      },
      {
        label: 'Plan follow-through',
        value: planValue,
        state: planState,
        note: planError
          ? 'Current week plan unavailable'
          : totalPlans === 0
            ? 'No plan items this week'
            : 'Current week plan',
      },
      {
        label: 'Source draft',
        value: sourceValue,
        state: sourceState,
        note: reportError
          ? 'Current week report unavailable'
          : !report
            ? 'No report for this week'
            : reportHasVariants
              ? 'Current week report · frozen facts'
              : 'Current week report · no variant snapshot',
      },
      {
        label: 'Final review',
        value: finalValue,
        state: finalState,
        note: reportError
          ? 'Current week report unavailable'
          : !report
            ? 'No report for this week'
            : reportHasVariants
              ? 'Current week report · audience finals'
              : 'Current week report · no variant snapshot',
      },
    ]
  }, [eventsCount, loading, planError, planItems, report, reportError])

  return (
    <section className={styles.readinessPanel} aria-label="Report readiness">
      <div className={styles.sectionHeading}>
        <div>
          <h2>Workflow readiness</h2>
          <p>Current week · live evidence and loaded report facts</p>
        </div>
        <Activity size={18} aria-hidden="true" />
      </div>
      <div className={styles.readinessCells}>
        {cells.map((cell) => (
          <div className={styles.readinessCell} key={cell.label} data-state={cell.state}>
            <span>{cell.label}</span>
            <strong className={styles.readinessValue}>{cell.value}</strong>
            <small>{cell.note}</small>
          </div>
        ))}
      </div>
    </section>
  )
}
