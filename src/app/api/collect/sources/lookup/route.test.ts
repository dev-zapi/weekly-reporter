import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'

const { mockRealpath, mockFindMany } = vi.hoisted(() => ({
  mockRealpath: vi.fn(),
  mockFindMany: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({
    query: {
      collectSources: { findMany: mockFindMany },
    },
  })),
}))

vi.mock('@/lib/collect/realpath', () => ({
  tryRealpath: mockRealpath,
}))

const makeSource = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  type: 'git-local',
  name: 'test-repo',
  projectScope: 'personal',
  enabled: true,
  status: 'enabled',
  config: {
    owner: '/home/god/github/repo',
    authorEmails: ['god@example.com'],
  },
  lastSyncAt: null,
  lastSyncStatus: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  ...overrides,
})

const makeRequest = (qs: string) =>
  new Request(`http://localhost/api/collect/sources/lookup?${qs}`)

describe('/api/collect/sources/lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRealpath.mockReset()
    mockRealpath.mockResolvedValue(null)
    mockFindMany.mockReset()
  })

  describe('GET', () => {
    it('returns 400 INVALID_TYPE when type is not git-local', async () => {
      const response = await GET(makeRequest('type=git-remote-github&path=/x'))
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.code).toBe('INVALID_TYPE')
    })

    it('returns 400 INVALID_TYPE when type is missing', async () => {
      const response = await GET(makeRequest('path=/x'))
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.code).toBe('INVALID_TYPE')
    })

    it('returns 400 INVALID_PATH when path is missing', async () => {
      const response = await GET(makeRequest('type=git-local'))
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.code).toBe('INVALID_PATH')
    })

    it('returns 400 INVALID_PATH when path is empty', async () => {
      const response = await GET(makeRequest('type=git-local&path='))
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.code).toBe('INVALID_PATH')
    })

    it('matches by exact string equality', async () => {
      const source = makeSource()
      mockFindMany.mockResolvedValueOnce([source])

      const response = await GET(makeRequest('type=git-local&path=/home/god/github/repo'))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.id).toBe(1)
      expect(body.config.token).toBe('[ENCRYPTED]')
    })

    it('expands ~ in the input path before matching', async () => {
      const source = makeSource({ config: { owner: `${process.env.HOME || '/home'}/github/repo`, authorEmails: ['a@b.com'] } })
      mockFindMany.mockResolvedValueOnce([source])

      const response = await GET(makeRequest('type=git-local&path=~/github/repo'))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.id).toBe(1)
    })

    it('strips trailing slash from input before matching', async () => {
      const source = makeSource()
      mockFindMany.mockResolvedValueOnce([source])

      const response = await GET(makeRequest('type=git-local&path=/home/god/github/repo/'))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.id).toBe(1)
    })

    it('matches via realpath-equivalence when both sides resolve', async () => {
      const source = makeSource({ config: { owner: '/home/god/github/real-repo', authorEmails: ['a@b.com'] } })
      mockFindMany.mockResolvedValueOnce([source])

      // Both the symlink input and the canonical owner resolve to the same path.
      mockRealpath.mockImplementation(async (p: string) => {
        if (p === '/home/god/github/symlink-repo' || p === '/home/god/github/real-repo') {
          return '/home/god/github/real-repo'
        }
        return null
      })

      const response = await GET(makeRequest('type=git-local&path=/home/god/github/symlink-repo'))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.id).toBe(1)
    })

    it('falls back to string-only match when input path is not on disk', async () => {
      const source = makeSource()
      mockFindMany.mockResolvedValueOnce([source])

      mockRealpath.mockResolvedValue(null)

      const response = await GET(makeRequest('type=git-local&path=/home/god/github/repo'))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.id).toBe(1)
    })

    it('returns 404 NOT_FOUND when no source matches', async () => {
      mockFindMany.mockResolvedValueOnce([makeSource()])

      const response = await GET(makeRequest('type=git-local&path=/nonexistent'))
      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.code).toBe('NOT_FOUND')
    })

    it('returns 404 when there are no git-local sources', async () => {
      mockFindMany.mockResolvedValueOnce([])

      const response = await GET(makeRequest('type=git-local&path=/home/god/github/repo'))
      expect(response.status).toBe(404)
    })

    it('picks the earliest id when multiple sources match', async () => {
      const older = makeSource({ id: 5 })
      const newer = makeSource({ id: 10 })
      mockFindMany.mockResolvedValueOnce([newer, older])

      const response = await GET(makeRequest('type=git-local&path=/home/god/github/repo'))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.id).toBe(5)
    })

    it('masks config.token as [ENCRYPTED]', async () => {
      const source = makeSource({
        config: { owner: '/home/god/github/repo', authorEmails: ['a@b.com'], token: 'secret-token' },
      })
      mockFindMany.mockResolvedValueOnce([source])

      const response = await GET(makeRequest('type=git-local&path=/home/god/github/repo'))
      const body = await response.json()
      expect(body.config.token).toBe('[ENCRYPTED]')
    })
  })
})
