import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { EventCard } from './EventCard'
import type { RawEvent } from '@/lib/db/schema'
import { apiFetch } from '@/lib/api-client'

const navigation = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push }),
}))

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
}))

describe('EventCard', () => {
  const makeEvent = (
    eventTime: Date | string | number,
    overrides: Partial<RawEvent> = {}
  ): RawEvent =>
    ({
      id: 1,
      content: '测试事件',
      source: 'manual',
      eventTime: eventTime as Date,
      isImportant: false,
      metadata: null,
      createdAt: new Date('2026-07-13T10:00:00'),
      updatedAt: new Date('2026-07-13T10:00:00'),
      ...overrides,
    }) as unknown as RawEvent

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T14:00:00'))
    navigation.push.mockReset()
    vi.mocked(apiFetch).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('时间显示', () => {
    it('应在 2 小时内显示相对时间', () => {
      const event = makeEvent(new Date('2026-07-13T13:00:00'))
      render(<EventCard event={event} />)
      // 大约 1 小时前 (or "1 hour ago" in English locale)
      expect(screen.getByText(/1.*(小时前|hour ago)/)).toBeInTheDocument()
    })

    it('应在几分钟内显示分钟级相对时间', () => {
      const event = makeEvent(new Date('2026-07-13T13:55:00'))
      render(<EventCard event={event} />)
      expect(screen.getByText(/5.*(分钟前|minutes ago)/)).toBeInTheDocument()
    })

    it('应在正好 2 小时时仍显示相对时间', () => {
      const event = makeEvent(new Date('2026-07-13T12:00:00'))
      render(<EventCard event={event} />)
      expect(screen.getByText(/2.*(小时前|hours ago)/)).toBeInTheDocument()
    })

    it('应在超过 2 小时后显示具体日期时间', () => {
      const event = makeEvent(new Date('2026-07-13T11:30:00'))
      render(<EventCard event={event} />)
      expect(screen.getByText(/2026.*11:30/)).toBeInTheDocument()
    })

    it('应正确格式化前一天超过 2 小时的事件', () => {
      const event = makeEvent(new Date('2026-07-12T09:15:00'))
      render(<EventCard event={event} />)
      expect(screen.getByText(/Jul.*12.*9:15|2026.*09:15/)).toBeInTheDocument()
    })

    it('应支持 ISO 8601 字符串输入', () => {
      const isoString = new Date('2026-07-13T13:30:00').toISOString()
      const event = makeEvent(isoString)
      render(<EventCard event={event} />)
      expect(screen.getByText(/30.*(分钟前|minutes ago)/)).toBeInTheDocument()
    })

    it('应支持时间戳数字输入', () => {
      const timestamp = new Date('2026-07-13T10:00:00').getTime()
      const event = makeEvent(timestamp)
      render(<EventCard event={event} />)
      expect(screen.getByText(/2026.*10:00/)).toBeInTheDocument()
    })
  })

  describe('时间详情提示', () => {
    it('git 事件 ≤2h：弹层包含 Authored 和 Synced 行', async () => {
      const event = makeEvent(new Date('2026-07-13T13:00:00'), {
        source: 'git',
        createdAt: new Date('2026-07-13T13:30:00'),
        updatedAt: new Date('2026-07-13T13:30:00'),
      })
      render(<EventCard event={event} />)
      const trigger = screen.getByRole('button', { name: /1.*(小时前|hour ago)/ })
      trigger.focus()
      await vi.advanceTimersByTimeAsync(0)
      expect(screen.getByText(/Authored:/)).toBeInTheDocument()
      expect(screen.getByText(/Synced:/)).toBeInTheDocument()
    })

    it('git 事件 >2h：卡片显示绝对时间，弹层只有 Synced，无 Authored', async () => {
      const event = makeEvent(new Date('2026-07-13T11:30:00'), {
        source: 'git',
        createdAt: new Date('2026-07-13T12:00:00'),
        updatedAt: new Date('2026-07-13T12:00:00'),
      })
      render(<EventCard event={event} />)
      // Card shows absolute time
      expect(screen.getByText(/2026.*11:30/)).toBeInTheDocument()
      const trigger = screen.getByRole('button', { name: /2026.*11:30/ })
      trigger.focus()
      await vi.advanceTimersByTimeAsync(0)
      expect(screen.getByText(/Synced:/)).toBeInTheDocument()
      expect(screen.queryByText(/Authored:/)).not.toBeInTheDocument()
    })

    it('手动 ≤2h，无回填无修改：弹层只有裸 eventTime', async () => {
      const event = makeEvent(new Date('2026-07-13T13:00:00'), {
        source: 'manual',
        createdAt: new Date('2026-07-13T13:00:00'),
        updatedAt: new Date('2026-07-13T13:00:00'),
      })
      render(<EventCard event={event} />)
      const trigger = screen.getByRole('button', { name: /1.*(小时前|hour ago)/ })
      trigger.focus()
      await vi.advanceTimersByTimeAsync(0)
      expect(screen.getByText(/Jul.*13.*1:00 PM|2026.*13:00/)).toBeInTheDocument()
      expect(screen.queryByText(/Recorded:/)).not.toBeInTheDocument()
      expect(screen.queryByText(/Updated:/)).not.toBeInTheDocument()
    })

    it('手动 ≤2h 且 backdated：出现 Recorded', async () => {
      const event = makeEvent(new Date('2026-07-13T13:00:00'), {
        source: 'manual',
        createdAt: new Date('2026-07-13T13:05:00'), // 5 min later, >60s diff
        updatedAt: new Date('2026-07-13T13:05:00'),
      })
      render(<EventCard event={event} />)
      const trigger = screen.getByRole('button', { name: /1.*(小时前|hour ago)/ })
      trigger.focus()
      await vi.advanceTimersByTimeAsync(0)
      expect(screen.getByText(/Recorded:/)).toBeInTheDocument()
    })

    it('手动 modified：出现 Updated', async () => {
      const event = makeEvent(new Date('2026-07-13T13:00:00'), {
        source: 'manual',
        createdAt: new Date('2026-07-13T13:00:00'),
        updatedAt: new Date('2026-07-13T13:10:00'), // > createdAt
      })
      render(<EventCard event={event} />)
      const trigger = screen.getByRole('button', { name: /1.*(小时前|hour ago)/ })
      trigger.focus()
      await vi.advanceTimersByTimeAsync(0)
      expect(screen.getByText(/Updated:/)).toBeInTheDocument()
    })

    it('手动 >2h 且无增量：弹层不出现', async () => {
      const event = makeEvent(new Date('2026-07-13T11:00:00'), {
        source: 'manual',
        createdAt: new Date('2026-07-13T11:00:00'),
        updatedAt: new Date('2026-07-13T11:00:00'),
      })
      render(<EventCard event={event} />)
      // Button still exists with absolute time
      const trigger = screen.getByRole('button', { name: /2026.*11:00/ })
      expect(trigger).toBeInTheDocument()
      trigger.focus()
      await vi.advanceTimersByTimeAsync(0)
      // Tooltip should not appear (disabled)
      expect(screen.queryByText(/Recorded:/)).not.toBeInTheDocument()
      expect(screen.queryByText(/Updated:/)).not.toBeInTheDocument()
      expect(screen.queryByText(/Authored:/)).not.toBeInTheDocument()
      expect(screen.queryByText(/Synced:/)).not.toBeInTheDocument()
    })
  })

  describe('评论引用标记 (cited-by marker)', () => {
    it('does not render the marker without citing comments', () => {
      const event = makeEvent(new Date('2026-07-13T13:00:00'))
      render(<EventCard event={event} />)
      expect(screen.queryByRole('button', { name: /cited by/i })).not.toBeInTheDocument()

      render(<EventCard event={event} commentReferrerCount={0} />)
      expect(screen.queryByRole('button', { name: /cited by/i })).not.toBeInTheDocument()
    })

    it('renders the cited-by marker when at least one comment cites the event', () => {
      const event = makeEvent(new Date('2026-07-13T13:00:00'))
      render(<EventCard event={event} commentReferrerCount={2} />)

      expect(screen.getByRole('button', { name: /cited by 2 comments/i })).toBeInTheDocument()
    })

    it('locates the citing plan item on the plans page when activated', async () => {
      vi.useRealTimers()
      vi.mocked(apiFetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            referrers: [],
            commentReferrers: {
              count: 1,
              comments: [
                {
                  commentId: 9,
                  planItemId: 42,
                  excerpt: 'Decision @7',
                  author: 'period-plans/claude',
                  createdAt: '2026-10-14T09:00:00.000Z',
                  scope: 'week',
                  periodStart: '2026-10-12',
                  periodEnd: '2026-10-18',
                  monthKey: null,
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

      const event = makeEvent(new Date('2026-07-13T13:00:00'))
      render(<EventCard event={event} commentReferrerCount={1} />)

      fireEvent.click(screen.getByRole('button', { name: /cited by 1 comment/i }))

      await waitFor(() => {
        expect(navigation.push).toHaveBeenCalledWith(
          '/plans?scope=week&start=2026-10-12&item=42',
        )
      })
    })
  })

  describe('numbered evidence row', () => {
    it('renders the stable @id beside the record', () => {
      const event = makeEvent(new Date('2026-07-13T13:00:00'), { id: 7 })
      render(<EventCard event={event} />)
      expect(screen.getByText('@7')).toBeInTheDocument()
    })

    it('selects the record for the evidence trace', () => {
      const onSelect = vi.fn()
      const event = makeEvent(new Date('2026-07-13T13:00:00'), { id: 7 })
      render(<EventCard event={event} onSelect={onSelect} />)

      const inspect = screen.getByRole('button', { name: 'Inspect event 7' })
      expect(inspect).toHaveAttribute('aria-pressed', 'false')
      fireEvent.click(inspect)
      expect(onSelect).toHaveBeenCalledWith(7)

      render(<EventCard event={event} selected onSelect={onSelect} />)
      expect(screen.getByRole('button', { name: 'Tracing event 7' })).toHaveAttribute('aria-pressed', 'true')
    })
  })

  describe('删除警告包含评论引用', () => {
    it('warns about citing plan item comments before deleting', async () => {
      vi.useRealTimers()
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
      vi.mocked(apiFetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            referrers: [],
            commentReferrers: {
              count: 1,
              comments: [
                {
                  commentId: 9,
                  planItemId: 42,
                  excerpt: 'Decision @7',
                  author: null,
                  createdAt: '2026-10-14T09:00:00.000Z',
                  scope: 'week',
                  periodStart: '2026-10-12',
                  periodEnd: '2026-10-18',
                  monthKey: null,
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

      const onDelete = vi.fn()
      const event = makeEvent(new Date('2026-07-13T13:00:00'), { id: 7 })
      render(<EventCard event={event} onDelete={onDelete} />)

      fireEvent.click(screen.getByRole('button', { name: 'Delete event' }))

      await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
      const message = String(confirmSpy.mock.calls.at(-1)?.[0])
      expect(message).toMatch(/cited by 1 plan item comment/i)
      expect(message).toContain('%42')
      expect(message).toContain('Decision @7')
      expect(onDelete).not.toHaveBeenCalled()
    })
  })
})
