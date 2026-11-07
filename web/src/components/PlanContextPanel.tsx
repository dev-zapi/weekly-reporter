import { ClipboardCheck } from 'lucide-react'
import {
  PLAN_ITEM_PRIORITY_LABELS,
  PLAN_ITEM_STATUS_LABELS,
} from '@/lib/plan-item-display'
import type { PeriodPlanScope } from '@/lib/db/schema'
import type { PlanRowItem } from './PeriodPlanItemRow'
import styles from './plan-surface.module.css'

type Props = {
  item: PlanRowItem | null
  periodLabel: string
  scope: PeriodPlanScope
  /** The month item an attached week item belongs to, when visible. */
  parentText?: string | null
}

/**
 * Persistent, read-only inspector for the selected plan item. Operations stay
 * on the numbered row; this panel keeps the selected item's planning context
 * and evidence attribution visible while the list is composed.
 */
export function PlanContextPanel({ item, periodLabel, scope, parentText = null }: Props) {
  if (!item) {
    return (
      <section className={styles.contextPanel} aria-label="Selected plan item">
        <div className={styles.sectionHeading}>
          <h2>Plan item</h2>
          <ClipboardCheck size={17} aria-hidden="true" />
        </div>
        <div className={styles.contextEmpty}>
          <ClipboardCheck size={22} aria-hidden="true" />
          <strong>No plan item selected</strong>
          <span>Select a numbered item to inspect its status, scope, fulfillment evidence, and planning context.</span>
        </div>
      </section>
    )
  }

  const fulfillmentCount = item.fulfillmentCount ?? 0
  const commentCount = item.commentCount ?? 0
  const hasSplit =
    typeof item.directFulfillmentCount === 'number' &&
    typeof item.indirectFulfillmentCount === 'number'

  return (
    <section className={styles.contextPanel} aria-label="Selected plan item">
      <div className={styles.sectionHeading}>
        <div>
          <h2>Plan item %{item.id}</h2>
          <p>{scope === 'week' ? 'Weekly plan' : 'Monthly review'} · {periodLabel}</p>
        </div>
        <ClipboardCheck size={17} aria-hidden="true" />
      </div>

      <p className={styles.inspectorText}>{`Selected item: ${item.text}`}</p>

      <div className={styles.rowBadges}>
        <span className={styles.badge} data-status={item.status}>
          {PLAN_ITEM_STATUS_LABELS[item.status]}
        </span>
        <span className={styles.badge}>{PLAN_ITEM_PRIORITY_LABELS[item.priority]} priority</span>
        <span className={styles.badge}>{item.projectScope === 'work' ? 'Work' : 'Personal'} scope</span>
      </div>

      <dl className={styles.definitionList}>
        <div>
          <dt>Status</dt>
          <dd>{PLAN_ITEM_STATUS_LABELS[item.status]}</dd>
        </div>
        <div>
          <dt>Project scope</dt>
          <dd>{item.projectScope === 'work' ? 'Work' : 'Personal'}</dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>{PLAN_ITEM_PRIORITY_LABELS[item.priority]}</dd>
        </div>
        <div>
          <dt>Important flag</dt>
          <dd>{item.isImportant ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Urgent flag</dt>
          <dd>{item.isUrgent ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Fulfillment</dt>
          <dd>{fulfillmentCount} linked events</dd>
        </div>
        {hasSplit && (
          <>
            <div>
              <dt>Direct fulfillment</dt>
              <dd>{item.directFulfillmentCount}</dd>
            </div>
            <div>
              <dt>Indirect fulfillment</dt>
              <dd>{item.indirectFulfillmentCount}</dd>
            </div>
          </>
        )}
        <div>
          <dt>Planning context</dt>
          <dd>{commentCount} comment records</dd>
        </div>
        {item.weekPeriodStart && item.weekPeriodEnd && (
          <div>
            <dt>Week assignment</dt>
            <dd>Week of {item.weekPeriodStart} to {item.weekPeriodEnd}</dd>
          </div>
        )}
        {parentText && (
          <div>
            <dt>Month parent</dt>
            <dd>{parentText}</dd>
          </div>
        )}
        {typeof item.deferredFromItemId === 'number' && (
          <div>
            <dt>Deferral chain</dt>
            <dd>From %{item.deferredFromItemId}</dd>
          </div>
        )}
      </dl>

      <p className={styles.traceCopy}>
        Fulfillment references originate on the event side. Plan comments are
        planning context, not timeline facts or report-source input.
      </p>
    </section>
  )
}
