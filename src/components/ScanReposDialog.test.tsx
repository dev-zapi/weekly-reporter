import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScanReposDialog } from './ScanReposDialog'

const { mockScanRepos, mockBatchAddSources } = vi.hoisted(() => ({
  mockScanRepos: vi.fn(),
  mockBatchAddSources: vi.fn(),
}))

vi.mock('@/app/collect/actions', () => ({
  scanRepos: mockScanRepos,
  batchAddSources: mockBatchAddSources,
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const mockFetch = vi.fn()
global.fetch = mockFetch

describe('ScanReposDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ directories: [{ name: 'projects', path: '/home/user/projects' }] }),
    } as Response)
  })

  it('closes directory suggestions before closing the dialog with Escape', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ScanReposDialog open onClose={onClose} onSuccess={vi.fn()} />)

    const input = screen.getByRole('combobox', { name: 'Directory to scan' })
    await user.type(input, '/home/user')
    expect(await screen.findByRole('listbox')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('adds only selected, not-yet-added repositories as local sources', async () => {
    mockScanRepos.mockResolvedValue({
      repos: [
        { path: '/tmp/new-repo', name: 'new-repo', alreadyAdded: false },
        { path: '/tmp/existing-repo', name: 'existing-repo', alreadyAdded: true },
      ],
    })
    mockBatchAddSources.mockResolvedValue({ success: true, addedCount: 1 })
    const onClose = vi.fn()
    const onSuccess = vi.fn()
    const user = userEvent.setup()
    render(<ScanReposDialog open onClose={onClose} onSuccess={onSuccess} />)

    await user.type(screen.getByRole('combobox', { name: 'Directory to scan' }), '/tmp')
    await user.click(screen.getByRole('button', { name: 'Scan directory' }))
    expect(await screen.findByRole('heading', { name: 'Scan results' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /existing-repo/ })).toBeDisabled()

    await user.click(screen.getByRole('checkbox', { name: /new-repo/ }))
    await user.click(screen.getByRole('button', { name: 'Add selected (1)' }))

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
    expect(mockBatchAddSources).toHaveBeenCalledWith([
      { path: '/tmp/new-repo', name: 'new-repo', alreadyAdded: false, authorEmails: [] },
    ])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows scan errors and an explicit no-repository state inline', async () => {
    mockScanRepos.mockResolvedValueOnce({ repos: [], error: 'Directory does not exist' })
    const user = userEvent.setup()
    render(<ScanReposDialog open onClose={vi.fn()} onSuccess={vi.fn()} />)

    await user.type(screen.getByRole('combobox', { name: 'Directory to scan' }), '/tmp/missing')
    await user.click(screen.getByRole('button', { name: 'Scan directory' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Directory does not exist')

    mockScanRepos.mockResolvedValueOnce({ repos: [] })
    await user.click(screen.getByRole('button', { name: 'Scan directory' }))
    expect(await screen.findByText('No repositories found')).toBeInTheDocument()
    expect(screen.getByText(/Try a parent directory or another path/)).toBeInTheDocument()
  })
})
