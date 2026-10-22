import { describe, it, expect } from 'vitest'
import { PERIOD_PLAN_ITEM_STATUSES } from '@/lib/db/schema'
import {
  PLAN_ITEM_STATUS_COLORS,
  PLAN_ITEM_STATUS_ICONS,
  PLAN_ITEM_STATUS_LABELS,
  PLAN_ITEM_STATUS_ORDER,
} from './plan-item-display'

describe('plan item display maps', () => {
  it('labels and colours every status', () => {
    for (const status of PERIOD_PLAN_ITEM_STATUSES) {
      expect(PLAN_ITEM_STATUS_LABELS[status]).toBeTruthy()
      expect(PLAN_ITEM_STATUS_COLORS[status]).toBeTruthy()
    }
  })

  it('lists every status exactly once in display order', () => {
    expect([...PLAN_ITEM_STATUS_ORDER].sort()).toEqual([...PERIOD_PLAN_ITEM_STATUSES].sort())
  })

  it('assigns an icon to every status', () => {
    for (const status of PERIOD_PLAN_ITEM_STATUSES) {
      expect(PLAN_ITEM_STATUS_ICONS[status]).toBeDefined()
    }
    expect(Object.keys(PLAN_ITEM_STATUS_ICONS)).toHaveLength(PERIOD_PLAN_ITEM_STATUSES.length)
  })
})
