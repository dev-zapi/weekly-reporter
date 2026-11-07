import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router'
import { verifyPassword, getStoredPassword, clearStoredPassword } from '@/lib/api-client'

/**
 * Client-side auth gate for the SPA root.
 *
 * On mount: if no stored password or verify fails → redirect to /login.
 * Lightweight: one verify on mount, no blocking spinner storms.
 *
 * `authEnabled` is resolved by the bootstrap headless GET /api/auth/verify
 * *before* the app mounts (WR_AUTH_DISABLED=1 turns the whole auth system off,
 * ADR-0020/0028) — when auth is off the gate stays silent: no redirect, no
 * verify roundtrip.
 */
export function AuthGate({ authEnabled }: { authEnabled: boolean }) {
  const navigate = useNavigate()
  const pathname = useLocation().pathname

  useEffect(() => {
    if (!authEnabled) {
      return
    }

    // Don't gate the login page itself
    if (pathname === '/login') {
      return
    }

    function redirectToLogin() {
      // Preserve the originally-requested path so login can bounce back.
      const target = pathname && pathname !== '/' ? pathname : ''
      navigate(
        target ? `/login?redirect=${encodeURIComponent(target)}` : '/login',
        { replace: true },
      )
    }

    async function verify() {
      const password = getStoredPassword()

      if (!password) {
        redirectToLogin()
        return
      }

      try {
        const { ok } = await verifyPassword(password)

        if (!ok) {
          clearStoredPassword()
          redirectToLogin()
        }
      } catch {
        // Network error — let the page render, apiFetch will handle 401s
      }
    }

    verify()
  }, [authEnabled, navigate, pathname])

  // Don't render anything — just gate via redirect.
  // No blocking UI; page content renders behind the gate.
  return null
}
