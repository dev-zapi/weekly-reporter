import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppShell } from './AppShell'
import { SyncAllSourcesProvider } from './SyncAllSources'
import { COMMIT_HASH } from '@/lib/build-info'
import { getWeekPeriodRange } from '@/lib/periods'

const { mockPathname } = vi.hoisted(() => ({ mockPathname: vi.fn() }))

vi.mock('next/navigation', () => ({
  usePathname: mockPathname,
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('./Settings', () => ({
  Settings: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog" aria-label="Settings" /> : null,
}))

vi.mock('./ThemeSwitcher', () => ({
  ThemeSwitcher: () => <button aria-label="Switch theme" />,
}))

function renderShell(children = <div data-testid="page-body" />) {
  return render(
    <SyncAllSourcesProvider>
      <AppShell>{children}</AppShell>
    </SyncAllSourcesProvider>,
  )
}

describe('AppShell', () => {
  beforeEach(() => {
    mockPathname.mockReset()
    mockPathname.mockReturnValue('/')
  })

  it('renders the period rail, primary destinations, and the page body', async () => {
    const week = getWeekPeriodRange(new Date())
    renderShell()

    expect(screen.getByText('weekly-reporter')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'Plans' })).toHaveAttribute('href', '/plans')
    expect(screen.getByRole('link', { name: 'Reports' })).toHaveAttribute('href', '/reports')
    expect(screen.getByTestId('page-body')).toBeInTheDocument()
    expect(await screen.findByText(week.start)).toBeInTheDocument()
    expect(screen.getByText(week.end)).toBeInTheDocument()
  })

  it('marks the active destination, including nested report workspaces', () => {
    mockPathname.mockReturnValue('/reports/42')
    const { unmount } = renderShell()

    const reports = screen.getByRole('link', { name: 'Reports' })
    expect(reports).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Timeline' })).not.toHaveAttribute(
      'aria-current',
    )
    unmount()

    mockPathname.mockReturnValue('/plans')
    renderShell()
    expect(screen.getByRole('link', { name: 'Plans' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('preserves Library destinations with their existing hrefs', () => {
    mockPathname.mockReturnValue('/security')
    renderShell()

    expect(screen.getByText('Report templates').closest('a')).toHaveAttribute(
      'href',
      '/templates',
    )
    expect(screen.getByText('AI styles & prompts').closest('a')).toHaveAttribute(
      'href',
      '/prompts',
    )
    expect(screen.getByText('Collection sources').closest('a')).toHaveAttribute(
      'href',
      '/collect',
    )
    const security = screen.getByText('Security & tokens').closest('a')
    expect(security).toHaveAttribute('href', '/security')
    expect(security).toHaveAttribute('aria-current', 'page')
  })

  it('keeps sync, settings, and theme actions and hides sync only on /collect', () => {
    mockPathname.mockReturnValue('/')
    const { rerender } = renderShell()

    expect(screen.getByRole('button', { name: 'Sync all sources' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch theme' })).toBeInTheDocument()

    mockPathname.mockReturnValue('/collect')
    rerender(
      <SyncAllSourcesProvider>
        <AppShell>
          <div data-testid="page-body" />
        </AppShell>
      </SyncAllSourcesProvider>,
    )
    expect(
      screen.queryByRole('button', { name: 'Sync all sources' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()

    mockPathname.mockReturnValue('/collect/new')
    rerender(
      <SyncAllSourcesProvider>
        <AppShell>
          <div data-testid="page-body" />
        </AppShell>
      </SyncAllSourcesProvider>,
    )
    expect(screen.getByRole('button', { name: 'Sync all sources' })).toBeInTheDocument()
  })

  it('opens the existing settings surface from the rail', async () => {
    const user = userEvent.setup()
    renderShell()

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
  })

  it('keeps build and version information in the rail footer', () => {
    renderShell()

    const version = screen.getByText(/v0\.1\.0/)
    expect(version.textContent).toContain(`v0.1.0 · ${COMMIT_HASH}`)
  })

  it('does not render production chrome on /prototype or /login', () => {
    mockPathname.mockReturnValue('/prototype')
    const { unmount } = render(
      <AppShell>
        <div data-testid="prototype-child" />
      </AppShell>,
    )
    expect(screen.getByTestId('prototype-child')).toBeInTheDocument()
    expect(
      screen.queryByRole('complementary', { name: 'Workspace sidebar' }),
    ).not.toBeInTheDocument()
    unmount()

    mockPathname.mockReturnValue('/login')
    render(
      <AppShell>
        <div data-testid="login-child" />
      </AppShell>,
    )
    expect(screen.getByTestId('login-child')).toBeInTheDocument()
    expect(screen.queryByText('weekly-reporter')).not.toBeInTheDocument()
  })
})
