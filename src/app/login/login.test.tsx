import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import LoginPage from './page'

// Mock next/navigation
const mockReplace = vi.fn()
let mockSearchParams = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mockReplace,
  }),
  useSearchParams: () => mockSearchParams,
}))

describe('LoginPage', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockClear()
    localStorage.clear()
    mockReplace.mockClear()
    mockSearchParams = new URLSearchParams()
  })

  it('renders login form', () => {
    render(<LoginPage />)

    expect(screen.getByText('Weekly Reporter')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Startup password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
  })

  it('disables submit button when password is empty', () => {
    render(<LoginPage />)

    const submitButton = screen.getByRole('button', { name: /sign in/i })
    expect(submitButton).toBeDisabled()
  })

  it('enables submit button when password is entered', async () => {
    const user = userEvent.setup()
    render(<LoginPage />)

    const passwordInput = screen.getByPlaceholderText('Startup password')
    await user.type(passwordInput, 'test-password')

    const submitButton = screen.getByRole('button', { name: /sign in/i })
    expect(submitButton).toBeEnabled()
  })

  it('stores password and redirects on successful verify', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 })

    render(<LoginPage />)

    const passwordInput = screen.getByPlaceholderText('Startup password')
    await user.type(passwordInput, 'correct-password')

    const submitButton = screen.getByRole('button', { name: /sign in/i })
    await user.click(submitButton)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/verify', {
        headers: {
          Authorization: 'Bearer correct-password',
        },
      })
    })

    await waitFor(() => {
      expect(localStorage.getItem('weekly-reporter.auth')).toBe('correct-password')
      expect(mockReplace).toHaveBeenCalledWith('/')
    })
  })

  it('shows error on failed verify', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })

    render(<LoginPage />)

    const passwordInput = screen.getByPlaceholderText('Startup password')
    await user.type(passwordInput, 'wrong-password')

    const submitButton = screen.getByRole('button', { name: /sign in/i })
    await user.click(submitButton)

    await waitFor(() => {
      expect(screen.getByText('Invalid password')).toBeInTheDocument()
    })

    expect(localStorage.getItem('weekly-reporter.auth')).toBeNull()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('shows error on network failure', async () => {
    const user = userEvent.setup()
    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    render(<LoginPage />)

    const passwordInput = screen.getByPlaceholderText('Startup password')
    await user.type(passwordInput, 'test-password')

    const submitButton = screen.getByRole('button', { name: /sign in/i })
    await user.click(submitButton)

    await waitFor(() => {
      expect(screen.getByText('Network error. Please try again.')).toBeInTheDocument()
    })

    expect(localStorage.getItem('weekly-reporter.auth')).toBeNull()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('redirects to custom path from redirect param', async () => {
    const user = userEvent.setup()
    mockSearchParams.set('redirect', '/reports')
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 })

    render(<LoginPage />)

    const passwordInput = screen.getByPlaceholderText('Startup password')
    await user.type(passwordInput, 'test-password')

    const submitButton = screen.getByRole('button', { name: /sign in/i })
    await user.click(submitButton)

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/reports')
    })
  })

  it('shows loading state during verify', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation(() => new Promise(() => {})) // Never resolves

    render(<LoginPage />)

    const passwordInput = screen.getByPlaceholderText('Startup password')
    await user.type(passwordInput, 'test-password')

    const submitButton = screen.getByRole('button', { name: /sign in/i })
    await user.click(submitButton)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /verifying/i })).toBeInTheDocument()
    })
  })
})
