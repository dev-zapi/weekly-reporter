// SPA entry — the counterpart of src/app/layout.tsx.
//
// Differences from Next:
//  - authEnabled is computed on the server there; here it is probed *before*
//    mounting: a headless GET /api/auth/verify returns 200 when auth is off
//    (WR_AUTH_DISABLED=1) and 401 when it is on. Rendering first would let
//    AuthGate redirect before the flag is known (ADR-0028). Any probe failure
//    is treated as "auth enabled" (fail closed), matching the Next version.
//  - File-system routing becomes an explicit <Routes> table. The 15 routes are
//    1:1 with src/app; all pages are wired in.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router'

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

/**
 * Catch-all fallback for routes that don't match the 15-route table.
 */
function PendingPage({ path }: { path: string }) {
  return (
    <div role="status" style={{ padding: 24, opacity: 0.6 }}>
      <strong>{path}</strong>
      <p>This page is not migrated to the SPA yet (B7 follow-up batch).</p>
    </div>
  )
}

function Root({ authEnabled }: { authEnabled: boolean }) {
  return (
    <BrowserRouter>
      <AuthGate authEnabled={authEnabled} />
      <ThemeProvider>
        <SyncAllSourcesProvider>
          <AppShell>
            <Routes>
              <Route path="/" element={<TimelinePage />} />
              <Route path="/new" element={<NewReportPage />} />
              <Route path="/edit/:id" element={<EditReportPage />} />
              <Route path="/plans" element={<PlansPage />} />
              <Route path="/login" element={<LoginPage />} />

              <Route path="/collect" element={<CollectPage />} />
              <Route path="/collect/new" element={<NewCollectSourcePage />} />
              <Route path="/collect/:id" element={<EditCollectSourcePage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/reports/:id" element={<ReportDetailPage />} />
              <Route path="/templates" element={<TemplatesPage />} />
              <Route path="/templates/new" element={<NewTemplatePage />} />
              <Route path="/templates/:id" element={<EditTemplatePage />} />
              <Route path="/prompts" element={<PromptsPage />} />
              <Route path="/security" element={<SecurityPage />} />

              <Route path="*" element={<PendingPage path="(unknown route)" />} />
            </Routes>
          </AppShell>
        </SyncAllSourcesProvider>
      </ThemeProvider>
      <Toaster />
    </BrowserRouter>
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
