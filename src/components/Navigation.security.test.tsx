import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Navigation } from './Navigation'
import { SyncAllSourcesProvider } from './SyncAllSources'

vi.mock('next/navigation', () => ({
  usePathname: () => '/security',
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('./Settings', () => ({
  SettingsButton: () => <button aria-label="settings" />,
}))

vi.mock('./ThemeSwitcher', () => ({
  ThemeSwitcher: () => <button aria-label="theme" />,
}))

describe('Navigation security item', () => {
  it('renders a Security nav link pointing at /security', () => {
    render(
      <SyncAllSourcesProvider>
        <Navigation />
      </SyncAllSourcesProvider>,
    )

    const link = screen.getByRole('link', { name: /security/i })
    expect(link).toHaveAttribute('href', '/security')
  })
})
