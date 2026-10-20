import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import SecurityPage from './page'

const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof fetch

// Mock next/navigation
const { mockPush, mockReplace } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockReplace: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/security',
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: vi.fn() }),
}))

// Mock toast
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

function mockJsonResponse(data: unknown, init: { status?: number; ok?: boolean } = {}) {
  return {
    ok: init.ok ?? (init.status ? init.status < 400 : true),
    status: init.status ?? 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response
}

const SAMPLE_PATS = [
  {
    id: 1,
    name: 'ci-bot',
    prefix: 'wrp_aBcD',
    createdAt: 1700000000000,
    lastUsedAt: 1700001000000,
    expiresAt: null,
    revokedAt: null,
  },
  {
    id: 2,
    name: 'expired-one',
    prefix: 'wrp_eFgH',
    createdAt: 1600000000000,
    lastUsedAt: null,
    expiresAt: 1600100000000, // expired
    revokedAt: null,
  },
  {
    id: 3,
    name: 'revoked-one',
    prefix: 'wrp_iJkL',
    createdAt: 1600000000000,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: 1600200000000,
  },
]

const SAMPLE_AUDIT_RECORDS = [
  {
    id: 101,
    createdAt: 1700001500000,
    patName: 'ci-bot',
    method: 'POST',
    apiPath: '/api/events',
    status: 201,
    userAgent: 'node/20',
    agentIdentity: 'collect-sources/claude-code',
    callerCwd: '/home/me/project',
    outcome: 'success',
  },
  {
    id: 102,
    createdAt: 1700001600000,
    patName: 'bad-token',
    method: 'GET',
    apiPath: '/api/events',
    status: 401,
    userAgent: 'curl/8',
    agentIdentity: null,
    callerCwd: null,
    outcome: 'unauthorized',
  },
]

describe('SecurityPage — PAT section', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(mockJsonResponse({ pats: [] }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the PAT list with names, prefixes, and status badges', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ pats: SAMPLE_PATS }))

    render(<SecurityPage />)

    expect(await screen.findByText('ci-bot')).toBeInTheDocument()
    expect(await screen.findByText('wrp_aBcD')).toBeInTheDocument()
    expect(await screen.findByText('expired-one')).toBeInTheDocument()
    expect(await screen.findByText('revoked-one')).toBeInTheDocument()

    // Status badges
    expect(await screen.findByText('Active')).toBeInTheDocument()
    expect(await screen.findByText('Expired')).toBeInTheDocument()
    expect(await screen.findByText('Revoked')).toBeInTheDocument()
  })

  it('shows loading state before PATs are fetched', () => {
    mockFetch.mockReturnValueOnce(new Promise(() => {})) // never resolves
    render(<SecurityPage />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('creates a PAT and shows the one-time plaintext token with warning', async () => {
    const user = userEvent.setup()
    const createdPat = { id: 99, name: 'new-pat', token: 'wrp_brandNewTokenValue', createdAt: 1700000000000 }
    mockFetch
      .mockResolvedValueOnce(mockJsonResponse({ pats: [] })) // initial list
      .mockResolvedValueOnce(mockJsonResponse(createdPat, { status: 201 })) // create
      .mockResolvedValueOnce(mockJsonResponse({ pats: [...SAMPLE_PATS, { id: 99, name: 'new-pat', prefix: 'wrp_brNd', createdAt: 1700000000000, lastUsedAt: null, expiresAt: null, revokedAt: null }] })) // refreshed list

    render(<SecurityPage />)

    // Wait for initial load (empty list → form is ready)
    await screen.findByPlaceholderText(/token name/i)

    // Fill in name and submit create form
    const nameInput = screen.getByPlaceholderText(/token name/i)
    await user.type(nameInput, 'new-pat')
    const createButton = screen.getByRole('button', { name: /create/i })
    await user.click(createButton)

    // One-time token display with warning
    const tokenDisplay = await screen.findByText('wrp_brandNewTokenValue')
    expect(tokenDisplay).toBeInTheDocument()
    expect(screen.getByText(/only shown once/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument()
  })

  it('copies the token to clipboard when copy button is clicked', async () => {
    const user = userEvent.setup()
    const createdPat = { id: 99, name: 'new-pat', token: 'wrp_copyMe', createdAt: 1700000000000 }
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    mockFetch
      .mockResolvedValueOnce(mockJsonResponse({ pats: [] }))
      .mockResolvedValueOnce(mockJsonResponse(createdPat, { status: 201 }))
      .mockResolvedValueOnce(mockJsonResponse({ pats: [] }))

    render(<SecurityPage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    const nameInput = screen.getByPlaceholderText(/token name/i)
    await user.type(nameInput, 'new-pat')
    await user.click(screen.getByRole('button', { name: /create/i }))

    await screen.findByText('wrp_copyMe')
    await user.click(screen.getByRole('button', { name: /copy/i }))

    expect(writeText).toHaveBeenCalledWith('wrp_copyMe')
  })

  it('revokes a PAT after confirmation', async () => {
    const user = userEvent.setup()
    mockFetch
      .mockResolvedValueOnce(mockJsonResponse({ pats: [SAMPLE_PATS[0]] })) // initial list
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // revoke
      .mockResolvedValueOnce(mockJsonResponse({ pats: [{ ...SAMPLE_PATS[0], revokedAt: Date.now() }] })) // refreshed list

    // Mock window.confirm
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<SecurityPage />)
    await screen.findByText('ci-bot')

    const revokeButton = screen.getByRole('button', { name: /revoke/i })
    await user.click(revokeButton)

    expect(confirmSpy).toHaveBeenCalled()
    await waitFor(() => {
      const revokeCall = mockFetch.mock.calls.find(
        ([url, init]) => url === '/api/auth/pats/1' && init?.method === 'DELETE',
      )
      expect(revokeCall).toBeDefined()
    })

    confirmSpy.mockRestore()
  })

  it('does not revoke when user cancels confirmation', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ pats: [SAMPLE_PATS[0]] }))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<SecurityPage />)
    await screen.findByText('ci-bot')

    const revokeButton = screen.getByRole('button', { name: /revoke/i })
    await user.click(revokeButton)

    // DELETE should NOT be called
    const deleteCalls = mockFetch.mock.calls.filter(
      ([, init]) => init?.method === 'DELETE',
    )
    expect(deleteCalls).toHaveLength(0)

    confirmSpy.mockRestore()
  })
})

describe('SecurityPage — Audit section', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(mockJsonResponse({ pats: [] }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders audit records with all columns', async () => {
    const user = userEvent.setup()
    mockFetch
      .mockResolvedValueOnce(mockJsonResponse({ pats: [] })) // PAT list
      .mockResolvedValueOnce(mockJsonResponse({ records: SAMPLE_AUDIT_RECORDS, total: 2, limit: 50, offset: 0 })) // audit

    render(<SecurityPage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    // Switch to audit tab
    const auditTab = screen.getByRole('tab', { name: /audit/i })
    await user.click(auditTab)

    // Check records appear
    expect(await screen.findByText('ci-bot')).toBeInTheDocument()
    expect(screen.getAllByText('/api/events').length).toBeGreaterThan(0)
    expect(screen.getByText('POST')).toBeInTheDocument()
    expect(screen.getByText('201')).toBeInTheDocument()
    expect(screen.getByText('collect-sources/claude-code')).toBeInTheDocument()
    expect(screen.getByText('/home/me/project')).toBeInTheDocument()
    expect(screen.getByText('node/20')).toBeInTheDocument()
  })

  it('paginates audit records using limit/offset query params', async () => {
    const user = userEvent.setup()
    mockFetch
      .mockResolvedValueOnce(mockJsonResponse({ pats: [] }))
      .mockResolvedValueOnce(mockJsonResponse({ records: SAMPLE_AUDIT_RECORDS, total: 120, limit: 50, offset: 0 }))
      .mockResolvedValueOnce(mockJsonResponse({ records: SAMPLE_AUDIT_RECORDS, total: 120, limit: 50, offset: 50 }))

    render(<SecurityPage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    const auditTab = screen.getByRole('tab', { name: /audit/i })
    await user.click(auditTab)
    await screen.findByText('ci-bot')

    // Click "Next"
    const nextButton = screen.getByRole('button', { name: /next/i })
    await user.click(nextButton)

    await waitFor(() => {
      const auditCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.startsWith('/api/audit') && url.includes('offset=50'),
      )
      expect(auditCall).toBeDefined()
    })
  })

  it('filters audit records by PAT name and status via query params', async () => {
    const user = userEvent.setup()
    mockFetch
      .mockResolvedValueOnce(mockJsonResponse({ pats: [] }))
      .mockResolvedValueOnce(mockJsonResponse({ records: SAMPLE_AUDIT_RECORDS, total: 1, limit: 50, offset: 0 }))
      .mockResolvedValueOnce(mockJsonResponse({ records: [], total: 0, limit: 50, offset: 0 }))

    render(<SecurityPage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    const auditTab = screen.getByRole('tab', { name: /audit/i })
    await user.click(auditTab)
    await screen.findByText('ci-bot')

    // Fill in filter
    const patNameFilter = screen.getByPlaceholderText(/pat name/i)
    await user.type(patNameFilter, 'ci-bot')
    const statusFilter = screen.getByPlaceholderText(/status/i)
    await user.type(statusFilter, '201')

    // Trigger search
    const searchButton = screen.getByRole('button', { name: /search/i })
    await user.click(searchButton)

    await waitFor(() => {
      const filteredCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.startsWith('/api/audit') && url.includes('patName=ci-bot') && url.includes('status=201'),
      )
      expect(filteredCall).toBeDefined()
    })
  })
})
