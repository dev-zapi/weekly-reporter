import { render, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuthGate } from './AuthGate'

const mockReplace = vi.fn()
let mockPathname = '/'

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mockReplace,
  }),
  usePathname: () => mockPathname,
}))

describe('AuthGate', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockClear()
    mockReplace.mockClear()
    localStorage.clear()
    mockPathname = '/'
  })

  it('redirects to /login when no password is stored', async () => {
    render(<AuthGate authEnabled />)

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login')
    })

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('preserves the requested path in the redirect param', async () => {
    mockPathname = '/reports'
    render(<AuthGate authEnabled />)

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login?redirect=%2Freports')
    })
  })

  it('does not redirect when verify succeeds', async () => {
    localStorage.setItem('weekly-reporter.auth', 'good-password')
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 })

    render(<AuthGate authEnabled />)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/verify', {
        headers: { Authorization: 'Bearer good-password' },
      })
    })

    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('clears password and redirects when verify fails', async () => {
    localStorage.setItem('weekly-reporter.auth', 'bad-password')
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })

    render(<AuthGate authEnabled />)

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login')
    })

    expect(localStorage.getItem('weekly-reporter.auth')).toBeNull()
  })

  it('does not gate the login page itself', async () => {
    mockPathname = '/login'
    render(<AuthGate authEnabled />)

    // Give the effect a tick to run
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockReplace).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('does not gate at all when auth is disabled', async () => {
    localStorage.clear()
    render(<AuthGate authEnabled={false} />)

    // Give the effect a tick to run
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockReplace).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
