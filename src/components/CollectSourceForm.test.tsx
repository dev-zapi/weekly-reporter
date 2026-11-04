import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CollectSourceForm, type FormData } from './CollectSourceForm'

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('./AuthorEmailPicker', () => ({
  AuthorEmailPicker: () => null,
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const mockFetch = vi.fn()
global.fetch = mockFetch

function requestUrl(input: string | URL | Request) {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

const remoteData: FormData = {
  type: 'git-remote-github',
  name: 'Backend repository',
  projectScope: 'work',
  aliases: ['Backend service'],
  config: {
    baseUrl: '',
    owner: 'my-org',
    repo: 'backend-api',
    token: 'secret-token',
    authorEmails: 'dev@example.com',
    branches: [{ name: 'main', lastCommitTime: '2026-10-01T00:00:00.000Z' }],
  },
  enabled: true,
}

describe('CollectSourceForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockImplementation((input: string | URL | Request) => {
      const url = requestUrl(input)
      if (url === '/api/collect/sources' || url === '/api/collect/sources/7') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ authors: [], branches: [], currentBranch: '' }),
      } as Response)
    })
  })

  it('creates a remote source with scope, aliases, author emails, and branch values intact', async () => {
    const user = userEvent.setup()
    render(<CollectSourceForm />)

    await user.type(screen.getByLabelText('Source name'), 'Backend repository')
    await user.click(screen.getByRole('radio', { name: 'Work project' }))
    await user.type(screen.getByPlaceholderText('e.g. Backend service, API platform'), 'Backend service{Enter}')
    await user.type(screen.getByLabelText('Repository owner or organization'), 'my-org')
    await user.type(screen.getByLabelText('Repository name'), 'backend-api')
    await user.type(screen.getByLabelText('Personal access token'), 'secret-token')
    await user.type(screen.getByLabelText('Branches'), 'main{Enter}')
    await user.type(screen.getByPlaceholderText('e.g. user@example.com, work@company.com'), 'dev@example.com')
    await user.click(screen.getByRole('button', { name: 'Save source' }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/collect'))
    const submit = mockFetch.mock.calls.find(call => requestUrl(call[0]) === '/api/collect/sources')
    expect(submit?.[1]).toMatchObject({ method: 'POST' })
    expect(JSON.parse(String(submit?.[1]?.body))).toEqual({
      type: 'git-remote-github',
      name: 'Backend repository',
      projectScope: 'work',
      aliases: ['Backend service'],
      config: {
        owner: 'my-org',
        repo: 'backend-api',
        token: 'secret-token',
        authorEmails: ['dev@example.com'],
        branches: [{ name: 'main', lastCommitTime: null }],
      },
      enabled: true,
    })
  })

  it('keeps local path and branch cursor semantics when editing a source', async () => {
    const user = userEvent.setup()
    const localData: FormData = {
      ...remoteData,
      type: 'git-local',
      config: {
        ...remoteData.config,
        owner: '/home/user/projects/backend',
        repo: '',
        token: '',
      },
      enabled: false,
    }
    render(<CollectSourceForm sourceId={7} initialData={localData} />)

    expect(screen.queryByLabelText('Repository name')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Personal access token')).not.toBeInTheDocument()
    expect(screen.getByTitle(/^Synced through .+ \(committer date\)$/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save source' }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/collect'))
    const submit = mockFetch.mock.calls.find(call => requestUrl(call[0]) === '/api/collect/sources/7')
    expect(submit?.[1]).toMatchObject({ method: 'PUT' })
    expect(JSON.parse(String(submit?.[1]?.body))).toEqual({
      type: 'git-local',
      name: 'Backend repository',
      projectScope: 'work',
      aliases: ['Backend service'],
      config: {
        owner: '/home/user/projects/backend',
        authorEmails: ['dev@example.com'],
        branches: [{ name: 'main', lastCommitTime: '2026-10-01T00:00:00.000Z' }],
      },
      enabled: false,
    })
  })

  it('shows server validation failures inline without navigating away', async () => {
    mockFetch.mockImplementation((input: string | URL | Request) => {
      const url = requestUrl(input)
      if (url === '/api/collect/sources') {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({
            error: 'Invalid source configuration',
            details: { issues: [{ message: 'Repository owner is required' }] },
          }),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ authors: [], branches: [], currentBranch: '' }),
      } as Response)
    })
    const user = userEvent.setup()
    render(<CollectSourceForm initialData={remoteData} />)

    await user.click(screen.getByRole('button', { name: 'Save source' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid source configuration: Repository owner is required',
    )
    expect(mockPush).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save source' })).toBeEnabled()
  })
})
