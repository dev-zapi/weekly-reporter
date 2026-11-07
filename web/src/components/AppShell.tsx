import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useLocation } from 'react-router'
import {
  ArrowRight,
  BookOpen,
  CalendarCheck,
  CalendarDays,
  ChevronRight,
  Clock,
  Cloud,
  FileStack,
  FileText,
  Library,
  MessageSquare,
  Settings as SettingsIcon,
  Shield,
} from 'lucide-react'
import { Settings } from './Settings'
import { SyncAllSourcesButton } from './SyncAllSources'
import { ThemeSwitcher } from './ThemeSwitcher'
import { BUILD_TIME, COMMIT_HASH } from '@/lib/build-info'
import { getWeekPeriodRange } from '@/lib/periods'
import { cn } from '@/lib/utils'
import styles from './AppShell.module.css'

const APP_VERSION = '0.1.0'

const PRIMARY_NAV = [
  { href: '/', label: 'Timeline', icon: Clock },
  { href: '/plans', label: 'Plans', icon: CalendarCheck },
  { href: '/reports', label: 'Reports', icon: FileText },
] as const

const LIBRARY_NAV = [
  { href: '/templates', label: 'Report templates', icon: FileStack },
  { href: '/prompts', label: 'AI styles & prompts', icon: MessageSquare },
  { href: '/collect', label: 'Collection sources', icon: Cloud },
  { href: '/security', label: 'Security & tokens', icon: Shield },
] as const

function isActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(`${href}/`)
}

// The week follows the viewer's local calendar, which the static prerender
// cannot know. useSyncExternalStore uses the empty server snapshot during SSR
// and hydration, then re-renders with the real client week without a mismatch.
const subscribeToWeek = () => () => {}
const getWeekSnapshot = () => {
  const { start, end } = getWeekPeriodRange(new Date())
  return `${start}|${end}`
}
const getServerWeekSnapshot = () => ''

function useClientWeekRange() {
  const snapshot = useSyncExternalStore(
    subscribeToWeek,
    getWeekSnapshot,
    getServerWeekSnapshot,
  )
  if (!snapshot) return null
  const [start, end] = snapshot.split('|')
  return { start, end }
}

function ProductMark() {
  return (
    <div className={styles.productMark}>
      <span className={styles.markIcon}>
        <BookOpen size={18} aria-hidden="true" />
      </span>
      <span className={styles.productText}>
        <strong className={styles.productName}>weekly-reporter</strong>
        <small className={styles.productTagline}>Personal evidence workbench</small>
      </span>
    </div>
  )
}

function LibraryMenu({ pathname }: { pathname: string }) {
  const detailsRef = useRef<HTMLDetailsElement>(null)

  // The layout persists across client navigation. Close the disclosure after a
  // destination is chosen so the next route starts with the rail collapsed.
  useEffect(() => {
    detailsRef.current?.removeAttribute('open')
  }, [pathname])

  return (
    <details className={styles.libraryMenu} ref={detailsRef}>
      <summary>
        <Library size={16} aria-hidden="true" />
        <span className={styles.librarySummaryLabel}>Library</span>
        <ChevronRight className={styles.libraryChevron} size={14} aria-hidden="true" />
      </summary>
      <div className={styles.libraryLinks}>
        <span className={styles.libraryHint}>Configuration and setup</span>
        {LIBRARY_NAV.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href)
          return (
            <Link
              key={href}
              to={href}
              className={styles.libraryLink}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{label}</span>
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          )
        })}
      </div>
    </details>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useLocation().pathname
  const [settingsOpen, setSettingsOpen] = useState(false)
  const week = useClientWeekRange()
  // Build time is displayed in UTC so it is identical on every renderer.
  const buildTime = `${BUILD_TIME.slice(0, 16).replace('T', ' ')} UTC`

  // /prototype is a throwaway, full-viewport artifact and /login is the
  // pre-authentication surface. Neither should inherit workspace chrome.
  if (pathname === '/login' || pathname.startsWith('/prototype')) {
    return <>{children}</>
  }

  return (
    <div className={styles.shell}>
      <aside className={styles.rail} aria-label="Workspace sidebar">
        <div className={styles.railTop}>
          <ProductMark />
          <div className={styles.railActions} role="group" aria-label="Workspace actions">
            {pathname !== '/collect' && <SyncAllSourcesButton />}
            <button
              type="button"
              className={styles.iconAction}
              aria-label="Settings"
              title="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon size={16} aria-hidden="true" />
            </button>
            <ThemeSwitcher />
          </div>
        </div>

        <div className={styles.railPeriod}>
          <CalendarDays size={20} aria-hidden="true" />
          <strong className={styles.periodTitle}>This week</strong>
          <span className={styles.periodRange}>{week?.start ?? '—'}</span>
          <span className={styles.periodRange}>{week?.end ?? '—'}</span>
        </div>

        <nav className={styles.railNav} aria-label="Primary">
          {PRIMARY_NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href)
            return (
              <Link
                key={href}
                to={href}
                className={cn(styles.navLink, active && styles.navLinkActive)}
                aria-current={active ? 'page' : undefined}
              >
                <Icon size={17} aria-hidden="true" />
                <span className={styles.navLabel}>{label}</span>
                <ChevronRight className={styles.navChevron} size={14} aria-hidden="true" />
              </Link>
            )
          })}
        </nav>

        <LibraryMenu pathname={pathname} />

        <div className={styles.railFoot}>
          <span className={styles.statusDot} aria-hidden="true" />
          <span>Single-user workspace</span>
          <span className={styles.railVersion}>
            v{APP_VERSION} · {COMMIT_HASH} · {buildTime}
          </span>
        </div>
      </aside>

      <div className={styles.gutter} aria-hidden="true" />

      <main className={styles.body}>
        {children}
        <Settings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </main>
    </div>
  )
}
