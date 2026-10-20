'use client'

const AUTH_STORAGE_KEY = 'weekly-reporter.auth'

/**
 * Read the stored startup password from localStorage.
 */
function getStoredPassword(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(AUTH_STORAGE_KEY)
  } catch {
    return null
  }
}

/**
 * Read the stored startup password / Bearer token from localStorage.
 *
 * Kept as a named export for compatibility with the interim shim that
 * shipped with the security page (T5); callers only rely on `apiFetch`.
 */
export function getAuthToken(): string | null {
  return getStoredPassword()
}

/**
 * Clear the stored password from localStorage.
 */
export function clearStoredPassword(): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY)
  } catch {
    // Ignore storage errors
  }
}

/**
 * Store the password in localStorage.
 */
export function setStoredPassword(password: string): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, password)
  } catch {
    // Ignore storage errors
  }
}

/**
 * Check if we're on the login page to avoid redirect loops.
 */
function isOnLoginPage(): boolean {
  if (typeof window === 'undefined') return false
  return window.location.pathname === '/login'
}

/**
 * Handle 401 responses by clearing auth and redirecting to login.
 * Avoids redirect loops when already on the login page.
 */
function handleUnauthorized(): void {
  clearStoredPassword()
  if (!isOnLoginPage()) {
    window.location.href = '/login'
  }
}

/**
 * Verify a candidate password against GET /api/auth/verify.
 *
 * Deliberately bypasses `apiFetch`: a failed verify is an expected 401 and
 * must NOT trigger the global clear-and-redirect side effect (that would
 * loop the login page and wipe its inline error). Throws on network error so
 * callers can distinguish "wrong password" (false) from "unreachable".
 */
export async function verifyPassword(password: string): Promise<boolean> {
  const response = await fetch('/api/auth/verify', {
    headers: {
      Authorization: `Bearer ${password}`,
    },
  })
  return response.ok
}

/**
 * Unified API fetch wrapper for client-side code.
 *
 * - Reads the startup password from localStorage
 * - Attaches Authorization: Bearer header
 * - On 401: clears localStorage and redirects to /login
 * - Returns the Response unchanged (caller handles json/text/stream)
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const password = getStoredPassword()

  // Merge headers: preserve existing headers and add Authorization
  const existingHeaders = init?.headers
  const mergedHeaders: Record<string, string> = {}

  // Copy existing headers (handles Headers instance, plain object, and array)
  if (existingHeaders) {
    if (existingHeaders instanceof Headers) {
      existingHeaders.forEach((value, key) => {
        mergedHeaders[key] = value
      })
    } else if (Array.isArray(existingHeaders)) {
      existingHeaders.forEach(([key, value]) => {
        mergedHeaders[key] = value
      })
    } else {
      Object.entries(existingHeaders).forEach(([key, value]) => {
        if (value !== undefined) {
          mergedHeaders[key] = value
        }
      })
    }
  }

  if (password) {
    mergedHeaders['Authorization'] = `Bearer ${password}`
  }

  // Spread init but exclude headers to avoid overwriting our merged headers
  const { headers: _, ...restInit } = init || {}

  const response = await fetch(path, {
    ...restInit,
    headers: mergedHeaders,
  })

  if (response.status === 401) {
    handleUnauthorized()
  }

  return response
}
