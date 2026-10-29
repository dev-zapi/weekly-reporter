import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiFetch, setStoredPassword, clearStoredPassword, verifyPassword, traceSuffix } from './api-client'

describe('api-client', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockClear()
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('apiFetch', () => {
    it('attaches Authorization header when password is stored', async () => {
      setStoredPassword('test-password')
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 })

      await apiFetch('/api/test')

      expect(mockFetch).toHaveBeenCalledWith('/api/test', expect.objectContaining({
        headers: expect.any(Object),
      }))

      const call = mockFetch.mock.calls[0]
      const headers = call[1].headers
      expect(headers.Authorization).toBe('Bearer test-password')
    })

    it('does not attach Authorization header when no password is stored', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 })

      await apiFetch('/api/test')

      const call = mockFetch.mock.calls[0]
      const headers = call[1].headers
      expect(headers.Authorization).toBeUndefined()
    })

    it('clears password and redirects on 401', async () => {
      setStoredPassword('test-password')
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })

      // Mock window.location
      const originalLocation = window.location
      delete (window as any).location
      ;(window as any).location = {
        ...originalLocation,
        pathname: '/some-page',
        href: '',
      }

      await apiFetch('/api/test')

      expect(localStorage.getItem('weekly-reporter.auth')).toBeNull()
      expect(window.location.href).toBe('/login')

      // Restore
      ;(window as any).location = originalLocation
    })

    it('does not redirect on 401 if already on login page', async () => {
      setStoredPassword('test-password')
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })

      const originalLocation = window.location
      delete (window as any).location
      ;(window as any).location = {
        ...originalLocation,
        pathname: '/login',
        href: '',
      }

      await apiFetch('/api/test')

      expect(localStorage.getItem('weekly-reporter.auth')).toBeNull()
      expect(window.location.href).toBe('')

      ;(window as any).location = originalLocation
    })

    it('preserves existing headers in init', async () => {
      setStoredPassword('test-password')
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 })

      await apiFetch('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: true }),
      })

      const call = mockFetch.mock.calls[0]
      const headers = call[1].headers
      expect(headers.Authorization).toBe('Bearer test-password')
      expect(headers['Content-Type']).toBe('application/json')
      expect(call[1].method).toBe('POST')
      expect(call[1].body).toBe('{"test":true}')
    })

    it('returns Response unchanged', async () => {
      setStoredPassword('test-password')
      const mockResponse = {
        ok: true,
        status: 200,
        json: async () => ({ data: 'test' }),
      }
      mockFetch.mockResolvedValueOnce(mockResponse)

      const response = await apiFetch('/api/test')

      expect(response).toBe(mockResponse)
    })
  })

  describe('setStoredPassword and clearStoredPassword', () => {
    it('stores and clears password', () => {
      setStoredPassword('my-password')
      expect(localStorage.getItem('weekly-reporter.auth')).toBe('my-password')

      clearStoredPassword()
      expect(localStorage.getItem('weekly-reporter.auth')).toBeNull()
    })
  })

  describe('verifyPassword', () => {
    it('returns ok when the server accepts the password', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 })

      await expect(verifyPassword('good-password')).resolves.toEqual({ ok: true, traceId: null })

      expect(mockFetch).toHaveBeenCalledWith('/api/auth/verify', {
        headers: { Authorization: 'Bearer good-password' },
      })
    })

    it('returns ok false on 401 without touching localStorage or redirecting', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })

      await expect(verifyPassword('bad-password')).resolves.toEqual({ ok: false, traceId: null })

      // Must not trigger the apiFetch clear-and-redirect side effect
      expect(localStorage.getItem('weekly-reporter.auth')).toBeNull()
    })

    it('returns the traceId from the response headers', async () => {
      const traceId = 'a'.repeat(32)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers({ 'x-trace-id': traceId }),
      })

      await expect(verifyPassword('bad-password')).resolves.toEqual({ ok: false, traceId })
    })

    it('rejects on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network down'))

      await expect(verifyPassword('any')).rejects.toThrow('network down')
    })
  })

  describe('traceSuffix', () => {
    it('returns a suffix when the response carries a trace id', () => {
      const response = new Response(null, {
        headers: { 'x-trace-id': 'b'.repeat(32) },
      })

      expect(traceSuffix(response)).toBe(` (trace: ${'b'.repeat(32)})`)
    })

    it('returns an empty string when the header is absent', () => {
      expect(traceSuffix(new Response(null))).toBe('')
    })

    it('returns an empty string for header-less response mocks', () => {
      expect(traceSuffix({ ok: false, status: 500 } as Response)).toBe('')
    })
  })
})
