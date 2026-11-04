import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CollectSourceList } from './CollectSourceList'

const mockSources = Array.from({ length: 5 }, (_, i) => ({
  id: i + 1,
  type: 'git-remote',
  name: `source-${i + 1}`,
  projectScope: (i % 2 === 0 ? 'work' : 'personal') as 'work' | 'personal',
  config: {
    owner: 'owner',
    repo: `repo-${i + 1}`,
    token: '[ENCRYPTED]',
    authorEmails: ['a@example.com'],
  },
  enabled: true,
  status: 'enabled' as const,
  lastSyncAt: null,
  lastSyncStatus: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}))

const mockLocalSource = {
  ...mockSources[0],
  id: 99,
  type: 'git-local',
  name: 'local-source',
  config: {
    ...mockSources[0].config,
    owner: '/tmp/repo',
    repo: undefined,
  },
}

describe('CollectSourceList', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.spyOn(global, 'fetch').mockImplementation((url: string | URL | Request) => {
      const urlString = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (urlString.includes('/api/collect/sources')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sources: mockSources, total: mockSources.length, page: 1, pageSize: 12 }),
        } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should keep focus on the search input while typing', async () => {
    const user = userEvent.setup()
    render(<CollectSourceList />)

    const input = await screen.findByPlaceholderText('Search by name…')
    expect(input).toBeInTheDocument()

    await user.click(input)
    expect(input).toHaveFocus()

    // Type multiple characters and assert focus is never lost
    await user.type(input, 'source')

    expect(input).toHaveValue('source')
    expect(input).toHaveFocus()
  })

  it('should not remount the search input while typing', async () => {
    const user = userEvent.setup()
    render(<CollectSourceList />)

    const input = await screen.findByPlaceholderText('Search by name…')
    const inputElement = input as HTMLElement

    // Track if input is removed from DOM during typing
    let removed = false
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.removedNodes)) {
          if (node === inputElement || (node instanceof Element && node.contains(inputElement))) {
            removed = true
          }
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })

    await user.click(input)
    await user.type(input, 'repo')

    observer.disconnect()

    expect(removed).toBe(false)
    expect(input).toHaveValue('repo')
    expect(input).toHaveFocus()
  })

  it('shows manual Fetch only for local Git sources', async () => {
    vi.mocked(global.fetch).mockImplementation((url: string | URL | Request) => {
      const urlString = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (urlString.includes('/api/collect/sources')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sources: [...mockSources, mockLocalSource], total: 6, page: 1, pageSize: 12 }),
        } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    })

    render(<CollectSourceList />)

    expect(await screen.findByTitle('Manual fetch')).toBeInTheDocument()
    expect(screen.getAllByTitle('Manual fetch')).toHaveLength(1)
  })

  it('shows stable source references and named record actions', async () => {
    render(<CollectSourceList />)

    expect(await screen.findByText('#1')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Edit source-1' })).toHaveAttribute('href', '/collect/1')
    expect(screen.getByRole('button', { name: 'Sync source-1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resync source-1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete source-1' })).toBeInTheDocument()
  })

  it('shows an explicit error with a retry action when loading fails', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Source index unavailable' }),
    } as Response)

    render(<CollectSourceList />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Source index unavailable')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
