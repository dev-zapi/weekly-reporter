import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'

const { mockFindFirst } = vi.hoisted(() => ({ mockFindFirst: vi.fn() }))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({
    query: { collectSources: { findFirst: mockFindFirst } },
  })),
}))

const requestWith = (query: string) =>
  new Request(`http://localhost/api/collect/sources/emails?${query}`)

describe('/api/collect/sources/emails', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { author: { email: 'dev@example.com', login: 'dev' }, commit: { author: { email: 'dev@example.com', name: 'Dev' } } },
      ]),
    }) as unknown as typeof fetch
  })

  it('uses the stored token when an edit form sends sourceId without a token', async () => {
    mockFindFirst.mockResolvedValueOnce({ id: 7, config: { owner: 'org', repo: 'repo', token: 'stored-token' } })

    const response = await GET(requestWith('type=git-remote-github&owner=org&repo=repo&sourceId=7'))
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.authors).toEqual([{ email: 'dev@example.com', name: 'Dev', count: 1 }])
    const [, init] = vi.mocked(global.fetch).mock.calls[0]
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer stored-token')
  })

  it('does not query the stored token when the form already sent one', async () => {
    const response = await GET(requestWith('type=git-remote-github&owner=org&repo=repo&sourceId=7&token=form-token'))

    expect(response.status).toBe(200)
    expect(mockFindFirst).not.toHaveBeenCalled()
    const [, init] = vi.mocked(global.fetch).mock.calls[0]
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer form-token')
  })

  it('returns an empty author list when no token and no sourceId are available', async () => {
    const response = await GET(requestWith('type=git-remote-github&owner=org&repo=repo'))
    const data = await response.json()

    expect(data.authors).toEqual([])
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled()
  })
})
