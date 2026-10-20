'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { verifyPassword } from '@/lib/api-client'

const AUTH_STORAGE_KEY = 'weekly-reporter.auth'

/**
 * Client-side auth gate for root layout.
 *
 * On mount: if no stored password or verify fails → redirect to /login.
 * Lightweight: one verify on mount, no blocking spinner storms.
 */
export function AuthGate() {
  const router = useRouter()
  const pathname = usePathname()
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    // Don't gate the login page itself
    if (pathname === '/login') {
      setChecked(true)
      return
    }

    async function verify() {
      const password = localStorage.getItem(AUTH_STORAGE_KEY)

      if (!password) {
        redirectToLogin()
        return
      }

      try {
        const ok = await verifyPassword(password)

        if (!ok) {
          localStorage.removeItem(AUTH_STORAGE_KEY)
          redirectToLogin()
          return
        }

        setChecked(true)
      } catch {
        // Network error — let the page render, apiFetch will handle 401s
        setChecked(true)
      }
    }

    function redirectToLogin() {
      // Preserve the originally-requested path so login can bounce back.
      const target = pathname && pathname !== '/' ? pathname : ''
      router.replace(target ? `/login?redirect=${encodeURIComponent(target)}` : '/login')
    }

    verify()
  }, [router, pathname])

  // Don't render anything — just gate via redirect
  // No blocking UI; page content renders behind the gate
  return null
}
