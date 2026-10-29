'use client'

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { verifyPassword, getStoredPassword, clearStoredPassword } from '@/lib/api-client'

/**
 * Client-side auth gate for root layout.
 *
 * On mount: if no stored password or verify fails → redirect to /login.
 * Lightweight: one verify on mount, no blocking spinner storms.
 *
 * `authEnabled` is passed from the server layout (WR_AUTH_DISABLED=1 turns the
 * whole auth system off, ADR-0020) — when auth is off the gate stays silent:
 * no redirect, no verify roundtrip.
 */
export function AuthGate({ authEnabled }: { authEnabled: boolean }) {
  const router = useRouter()
  const pathname = usePathname()

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
      router.replace(target ? `/login?redirect=${encodeURIComponent(target)}` : '/login')
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
  }, [authEnabled, router, pathname])

  // Don't render anything — just gate via redirect.
  // No blocking UI; page content renders behind the gate.
  return null
}
