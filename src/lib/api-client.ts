/**
 * Minimal API fetch wrapper.
 *
 * Reads the startup-password / Bearer token from localStorage
 * (`weekly-reporter.auth`) and attaches it as an Authorization header.
 *
 * When T4 lands with the full api-client.ts this file will be replaced by
 * that module; the surface here is intentionally a subset so the merge is
 * trivial (callers only use `apiFetch`).
 */

const AUTH_STORAGE_KEY = 'weekly-reporter.auth'

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(AUTH_STORAGE_KEY)
}

export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const token = getAuthToken()
  const headers = new Headers(init?.headers)
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const response = await fetch(path, { ...init, headers })

  if (response.status === 401 && typeof window !== 'undefined') {
    localStorage.removeItem(AUTH_STORAGE_KEY)
    window.location.href = '/login'
  }

  return response
}
