// SPA entry — the counterpart of src/app/layout.tsx.
//
// Differences from Next:
//  - authEnabled is computed on the server there; here it is probed *before*
//    mounting: a headless GET /api/auth/verify returns 200 when auth is off
//    (WR_AUTH_DISABLED=1) and 401 when it is on. Rendering first would let
//    AuthGate redirect before the flag is known (ADR-0028). Any probe failure
//    is treated as "auth enabled" (fail closed), matching the Next version.
//  - File-system routing becomes an explicit data-router table. The data router
//    also supplies navigation blockers used by dirty standalone editors.
import { StrictMode, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router'

import './styles/tailwind.css'
import './styles/fonts.css'

import { Toaster } from '@/components/ui/sonner'
import { ThemeProvider } from '@/components/ThemeProvider'
import { AppShell } from '@/components/AppShell'
import { SyncAllSourcesProvider } from '@/components/SyncAllSources'
import { AuthGate } from '@/components/AuthGate'
import LoginPage from '@/app/login/page'
import TimelinePage from '@/app/page'
import NewReportPage from '@/app/new/page'
import EditReportPage from '@/app/edit/[id]/page'
import PlansPage from '@/app/plans/page'
import CollectPage from '@/app/collect/page'
import NewCollectSourcePage from '@/app/collect/new/page'
import EditCollectSourcePage from '@/app/collect/[id]/page'
import ReportsPage from '@/app/reports/page'
import ReportDetailPage from '@/app/reports/[id]/page'
import TemplatesPage from '@/app/templates/page'
import NewTemplatePage from '@/app/templates/new/page'
import EditTemplatePage from '@/app/templates/[id]/page'
import PromptsPage from '@/app/prompts/page'
import NewAIStylePage from '@/app/prompts/styles/new/page'
import EditAIStylePage from '@/app/prompts/styles/[id]/page'
import SecurityPage from '@/app/security/page'

/**
 * fail-closed: a failed probe is treated as "auth enabled", like the Next
 * version's tightened behaviour.
 */
async function probeAuthEnabled(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/verify', { headers: { Accept: 'application/json' } })
    return !res.ok
  } catch {
    return true
  }
}

function PendingPage({ path }: { path: string }) {
  return (
    <div role="status" style={{ padding: 24, opacity: 0.6 }}>
      <strong>{path}</strong>
      <p>This page is not migrated to the SPA yet (B7 follow-up batch).</p>
    </div>
  )
}

function AppLayout({ authEnabled }: { authEnabled: boolean }) {
  return (
    <>
      <AuthGate authEnabled={authEnabled} />
      <ThemeProvider>
        <SyncAllSourcesProvider>
          <AppShell>
            <Outlet />
          </AppShell>
        </SyncAllSourcesProvider>
      </ThemeProvider>
    </>
  )
}

function Root({ authEnabled }: { authEnabled: boolean }) {
  const router = useMemo(() => createBrowserRouter([
    {
      element: <AppLayout authEnabled={authEnabled} />,
      children: [
        { path: '/', element: <TimelinePage /> },
        { path: '/new', element: <NewReportPage /> },
        { path: '/edit/:id', element: <EditReportPage /> },
        { path: '/plans', element: <PlansPage /> },
        { path: '/login', element: <LoginPage /> },
        { path: '/collect', element: <CollectPage /> },
        { path: '/collect/new', element: <NewCollectSourcePage /> },
        { path: '/collect/:id', element: <EditCollectSourcePage /> },
        { path: '/reports', element: <ReportsPage /> },
        { path: '/reports/:id', element: <ReportDetailPage /> },
        { path: '/templates', element: <TemplatesPage /> },
        { path: '/templates/new', element: <NewTemplatePage /> },
        { path: '/templates/:id', element: <EditTemplatePage /> },
        { path: '/prompts', element: <PromptsPage /> },
        { path: '/prompts/styles/new', element: <NewAIStylePage /> },
        { path: '/prompts/styles/:id', element: <EditAIStylePage /> },
        { path: '/security', element: <SecurityPage /> },
        { path: '*', element: <PendingPage path="(unknown route)" /> },
      ],
    },
  ]), [authEnabled])

  return (
    <>
      <RouterProvider router={router} />
      <Toaster />
    </>
  )
}

async function bootstrap() {
  const authEnabled = await probeAuthEnabled()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root authEnabled={authEnabled} />
    </StrictMode>,
  )
}

void bootstrap()
