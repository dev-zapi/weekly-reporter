import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import NewReportPage from './page'

const mockPush = vi.fn()
const mockFetch = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, back: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

global.fetch = mockFetch

const previewResponse = {
  variants: [
    { variant: 'leadership', sourceDraft: '- 领导事项' },
    { variant: 'personal', sourceDraft: '- 个人事项' },
  ],
}

function response(data: unknown, ok = true) {
  return { ok, json: () => Promise.resolve(data) }
}

describe('NewReportPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads a read-only preview automatically without persisting anything', async () => {
    mockFetch.mockResolvedValueOnce(response(previewResponse))
    render(<NewReportPage />)

    expect(screen.getByRole('heading', { name: 'New Report' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading source draft')
    await screen.findByText('Source draft preview (read-only)')
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/reports/preview', expect.objectContaining({ method: 'POST' })))
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('shows both audience variants and only has one submit action', async () => {
    mockFetch.mockResolvedValueOnce(response(previewResponse))
    render(<NewReportPage />)

    await screen.findByText('Source draft preview (read-only)')
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/reports/preview', expect.objectContaining({ method: 'POST' })))

    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      weekStart: expect.any(String),
      weekEnd: expect.any(String),
    })
    expect(screen.getByText('Source draft preview (read-only)')).toBeInTheDocument()
    expect(screen.getByText('领导事项')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Personal/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Preview source draft' })).not.toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: /Personal/ }))
    expect(await screen.findByText('个人事项')).toBeInTheDocument()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('persists only after the preview has loaded and create is clicked', async () => {
    mockFetch
      .mockResolvedValueOnce(response(previewResponse))
      .mockResolvedValueOnce(response({ report: { id: 7 } }))
    render(<NewReportPage />)

    await screen.findByText('Source draft preview (read-only)')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(mockFetch.mock.calls[1][0]).toBe('/api/reports')
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual(expect.objectContaining({
      title: expect.any(String),
      weekStart: expect.any(String),
      weekEnd: expect.any(String),
    }))
    expect(mockPush).toHaveBeenCalledWith('/reports/7?audience=leadership')
  })

  it('preserves the previewed audience after creation and renders readable preview prose', async () => {
    mockFetch
      .mockResolvedValueOnce(response(previewResponse))
      .mockResolvedValueOnce(response({ report: { id: 7 } }))
    render(<NewReportPage />)

    await screen.findByText('Source draft preview (read-only)')
    fireEvent.click(screen.getByRole('tab', { name: /Personal/ }))
    const personalDraft = await screen.findByText('个人事项')
    expect(personalDraft.closest('.read-only-prose')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/reports/7?audience=personal'))
  })

  it('clears an existing preview when the week changes', async () => {
    mockFetch
      .mockResolvedValueOnce(response(previewResponse))
      .mockResolvedValueOnce(response({
        variants: [
          { variant: 'leadership', sourceDraft: '- 下一周领导事项' },
          { variant: 'personal', sourceDraft: '- 下一周个人事项' },
        ],
      }))
    render(<NewReportPage />)

    await screen.findByText('Source draft preview (read-only)')
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))

    await screen.findByText('下一周领导事项')
    expect(screen.queryByText('领导事项')).not.toBeInTheDocument()
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('offers a retry when the automatic preview fails', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ error: '预览服务不可用' }, false))
      .mockResolvedValueOnce(response(previewResponse))
    render(<NewReportPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('预览服务不可用')
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('领导事项')).toBeInTheDocument()
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('shows an explicit empty state while keeping creation available for an empty draft', async () => {
    mockFetch.mockResolvedValueOnce(response({
      variants: [
        { variant: 'leadership', sourceDraft: '' },
        { variant: 'personal', sourceDraft: '' },
      ],
    }))
    render(<NewReportPage />)

    expect(await screen.findByText('No source draft entries')).toBeInTheDocument()
    expect(screen.getByText(/You can still create the report/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled()
  })

  it('links title validation to the field and does not persist a blank title', async () => {
    mockFetch.mockResolvedValueOnce(response(previewResponse))
    render(<NewReportPage />)

    await screen.findByText('领导事项')
    const titleInput = screen.getByLabelText('Title')
    fireEvent.change(titleInput, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(titleInput).toHaveAttribute('aria-invalid', 'true')
    expect(titleInput).toHaveAttribute('aria-describedby', 'title-error')
    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a title')
    expect(mockFetch).toHaveBeenCalledTimes(1)

    fireEvent.change(titleInput, { target: { value: 'Recovered title' } })
    expect(titleInput).not.toHaveAttribute('aria-invalid')
    expect(titleInput).toHaveAttribute('aria-describedby', 'title-help')
  })
})
