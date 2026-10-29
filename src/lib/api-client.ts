'use client'

import { TRACE_ID_HEADER } from '@/lib/trace/ids'

/** localStorage key holding the startup password / Bearer token. */
export const AUTH_STORAGE_KEY = 'weekly-reporter.auth'

/**
 * 从响应头读取 traceId（兼容测试里不带 headers 的 Response mock）。
 */
function readTraceId(response: Response): string | null {
  try {
    return response.headers.get(TRACE_ID_HEADER)
  } catch {
    return null
  }
}

/**
 * 给展示给用户的错误文案追加 trace 后缀，例如 " (trace: abc...)"。
 *
 * 服务端统一通过 `x-trace-id` 响应头返回 traceId，因此只有拿到 Response
 * 的调用点才能取到；没有该头（老服务端、测试 mock、网络异常）时返回空串，
 * 调用方直接拼接即可，文案保持原样。
 */
export function traceSuffix(response: Response): string {
  const traceId = readTraceId(response)
  return traceId ? ` (trace: ${traceId})` : ''
}

/**
 * Read the stored startup password from localStorage.
 */
export function getStoredPassword(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(AUTH_STORAGE_KEY)
  } catch {
    return null
  }
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
 * callers can distinguish "wrong password" (ok: false) from "unreachable".
 *
 * Returns the response traceId alongside the verdict so the login page can
 * surface it in the inline error (Sleuth-style support handoff).
 */
export async function verifyPassword(password: string): Promise<{ ok: boolean; traceId: string | null }> {
  const response = await fetch('/api/auth/verify', {
    headers: {
      Authorization: `Bearer ${password}`,
    },
  })
  return { ok: response.ok, traceId: readTraceId(response) }
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

  const response = await fetch(path, {
    ...init,
    headers: mergedHeaders,
  })

  if (response.status === 401) {
    handleUnauthorized()
  }

  return response
}
