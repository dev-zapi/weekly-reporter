import { Suspense, useState, FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { setStoredPassword, verifyPassword } from '@/lib/api-client'
import { Lock, AlertCircle, BookOpen } from 'lucide-react'
import styles from './login.module.css'

/**
 * Only allow same-app relative paths as post-login targets — absolute URLs,
 * protocol-relative URLs (`//host`) and backslash variants (`/\host`) fall
 * back to `/` instead of being handed to navigate().
 */
function isSafeRedirect(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\')
}

/**
 * Login form — reads the `redirect` query param and verifies the password.
 *
 * Split out so the `useSearchParams` call can be wrapped in a Suspense
 * boundary (required by Next.js when prerendering a static page).
 */
function LoginForm() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const redirectTo = searchParams.get('redirect') || '/'

  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const { ok, traceId } = await verifyPassword(password)

      if (ok) {
        setStoredPassword(password)
        navigate(isSafeRedirect(redirectTo) ? redirectTo : '/', { replace: true })
      } else {
        // 接口报错时把服务端返回的 traceId 拼在错误文案后，方便排查。
        setError(traceId ? `Invalid password (trace: ${traceId})` : 'Invalid password')
      }
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className={styles.screen}>
      <section className={styles.panel} aria-labelledby="login-heading">
        <header className={styles.heading}>
          <div className={styles.productMark}>
            <span className={styles.markIcon}>
              <BookOpen size={19} aria-hidden="true" />
            </span>
            <span>Personal evidence workbench</span>
          </div>
          <h1 id="login-heading">Weekly Reporter</h1>
          <p>Enter your startup password to continue</p>
        </header>

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="startup-password">Startup password</label>
            <div className={styles.passwordField}>
              <Lock size={16} aria-hidden="true" />
              <input
                id="startup-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Startup password"
                autoComplete="current-password"
                autoFocus
                disabled={loading}
                required
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'password-help password-error' : 'password-help'}
              />
            </div>
            <p id="password-help">Use the password generated for this weekly-reporter instance.</p>
          </div>

          {error && (
            <div id="password-error" className={styles.errorState} role="alert">
              <AlertCircle size={17} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            className={styles.submitButton}
            disabled={loading || !password}
            aria-busy={loading}
          >
            {loading ? 'Verifying...' : 'Sign in'}
          </button>
        </form>

        <footer className={styles.footer}>
          <span className={styles.statusDot} aria-hidden="true" />
          Single-user workspace
        </footer>
      </section>
    </main>
  )
}

/**
 * Login page — full-screen password entry.
 *
 * On submit: GET /api/auth/verify with candidate password.
 * Success: store in localStorage, redirect to originally-requested page (or /).
 * Failure: inline error, stay on page.
 */
export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className={styles.screen}>
          <div className={styles.loadingState} role="status">
            <span className={styles.loadingLine} aria-hidden="true" />
            Loading sign in…
          </div>
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  )
}
