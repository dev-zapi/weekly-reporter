import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { Settings } from './Settings'

describe('Settings font defaults', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.style.removeProperty('--font-ui')
    document.documentElement.style.removeProperty('--font-editor')
  })

  afterEach(() => {
    localStorage.clear()
    document.documentElement.style.removeProperty('--font-ui')
    document.documentElement.style.removeProperty('--font-editor')
  })

  it('keeps the approved Geist stack when no font preference is stored', async () => {
    render(<Settings isOpen onClose={vi.fn()} />)

    // Mounting the dialog must not replace the One-Family Geist typography
    // with a system-ui default before the user has saved anything.
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--font-ui')).toContain(
        '--font-geist-sans',
      )
    })
    expect(document.documentElement.style.getPropertyValue('--font-ui')).not.toBe(
      'system-ui, sans-serif',
    )
  })

  it('applies a stored font preference', async () => {
    localStorage.setItem('ui-font', 'Iowan Old Style, serif')
    render(<Settings isOpen onClose={vi.fn()} />)

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe(
        'Iowan Old Style, serif',
      )
    })
  })
})
