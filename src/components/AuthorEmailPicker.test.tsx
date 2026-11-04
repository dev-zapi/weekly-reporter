import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthorEmailPicker } from './AuthorEmailPicker'

const mockFetch = vi.fn()
global.fetch = mockFetch

const repoParams = {
  type: 'git-local',
  path: '/home/user/projects/backend',
  owner: '/home/user/projects/backend',
  branch: 'main',
}

describe('AuthorEmailPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('preserves the repository lookup and confirms the selected author identities', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        authors: [
          { email: 'alice@example.com', name: 'Alice', count: 4 },
          { email: 'bob@example.com', name: 'Bob', count: 1 },
        ],
      }),
    } as Response)
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <AuthorEmailPicker
        open
        onClose={onClose}
        onConfirm={onConfirm}
        currentEmails={['alice@example.com']}
        repoParams={repoParams}
      />,
    )

    expect(await screen.findByRole('button', { name: /Alice/ })).toHaveAttribute('aria-pressed', 'true')
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/collect/sources/emails?'),
      expect.anything(),
    )
    const requestUrl = String(mockFetch.mock.calls[0][0])
    expect(requestUrl).toContain('type=git-local')
    expect(requestUrl).toContain('path=%2Fhome%2Fuser%2Fprojects%2Fbackend')
    expect(requestUrl).toContain('branch=main')

    await user.click(screen.getByRole('button', { name: /Bob/ }))
    expect(screen.getByRole('status')).toHaveTextContent('Selected 2 / 2')
    await user.click(screen.getByRole('button', { name: 'Confirm selection (2)' }))

    expect(onConfirm).toHaveBeenCalledWith(['alice@example.com', 'bob@example.com'])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows author lookup failures and retries the same picker', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ error: 'Repository is unavailable' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          authors: [{ email: 'alice@example.com', name: 'Alice', count: 4 }],
        }),
      } as Response)
    const user = userEvent.setup()
    render(
      <AuthorEmailPicker
        open
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        currentEmails={[]}
        repoParams={repoParams}
      />,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Repository is unavailable')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: /Alice/ })).toBeInTheDocument()
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
