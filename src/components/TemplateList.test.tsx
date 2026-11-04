import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { TemplateList } from './TemplateList'

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/components/editor/MilkdownEditor', () => ({
  MilkdownEditor: ({ value, onChange, readOnly }: {
    value: string
    onChange: (value: string) => void
    readOnly?: boolean
  }) => (
    <textarea
      aria-label="Template editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      readOnly={readOnly}
    />
  ),
}))

const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof fetch

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Response
}

const templatesPayload = {
  official: [
    {
      id: 'official-general',
      name: 'General weekly',
      description: 'A general report structure.',
      tags: ['weekly'],
      content: '# Weekly report',
    },
  ],
  user: [
    {
      id: 12,
      name: 'Engineering copy',
      description: 'Personal engineering report.',
      tags: 'engineering',
      content: '# Engineering',
      aiStyle: 'technical',
      sourceTemplateId: 'official-general',
    },
  ],
}

describe('TemplateList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  it('keeps official and personal records distinct and clones through the existing API', async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/templates' && (!init?.method || init.method === 'GET')) {
        return jsonResponse(templatesPayload)
      }
      if (path === '/api/templates/clone' && init?.method === 'POST') {
        return jsonResponse({ template: { id: 13 } })
      }
      return jsonResponse({ error: 'Not found' }, false)
    })

    render(<TemplateList />)

    expect(await screen.findByText('official-general')).toBeInTheDocument()
    expect(screen.getByText('General weekly')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Personal templates/ }))
    expect(await screen.findByText('T12')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Edit template Engineering copy' })).toHaveAttribute(
      'href',
      '/templates/12',
    )

    fireEvent.click(screen.getByRole('tab', { name: /Official templates/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Quick clone' }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/templates/13'))
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/templates/clone',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sourceId: 'official-general' }),
      }),
    )
  })

  it('shows a retryable error state when the template index fails to load', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ error: 'Database unavailable' }, false))
      .mockResolvedValueOnce(jsonResponse(templatesPayload))

    render(<TemplateList />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading templates' }))

    expect(await screen.findByText('General weekly')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows recovery guidance when the personal collection is empty', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ official: [], user: [] }))
    render(<TemplateList />)

    fireEvent.click(await screen.findByRole('tab', { name: /Personal templates/ }))

    expect(await screen.findByText('No personal templates')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'New personal template' })).toHaveLength(2)
  })

  it('edits a clone in the dialog and saves it through the clone endpoint', async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/templates') return jsonResponse(templatesPayload)
      if (path === '/api/templates/clone' && init?.method === 'POST') {
        return jsonResponse({ template: { id: 14 } })
      }
      return jsonResponse({ error: 'Not found' }, false)
    })

    render(<TemplateList />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save as' }))

    fireEvent.change(await screen.findByLabelText('Template name'), {
      target: { value: 'My engineering weekly' },
    })
    fireEvent.change(screen.getByLabelText('Template editor'), {
      target: { value: '# Custom sections' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/templates/14'))
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/templates/clone',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          sourceId: 'official-general',
          name: 'My engineering weekly',
          content: '# Custom sections',
        }),
      }),
    )
    expect(toast.success).toHaveBeenCalledWith('Template saved')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps the clone dialog open and reports the server error when saving fails', async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/templates') return jsonResponse(templatesPayload)
      if (String(input) === '/api/templates/clone' && init?.method === 'POST') {
        return jsonResponse({ error: 'Template name already exists' }, false)
      }
      return jsonResponse({ error: 'Not found' }, false)
    })

    render(<TemplateList />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save as' }))
    fireEvent.change(await screen.findByLabelText('Template name'), {
      target: { value: 'Duplicate name' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Template name already exists')
    })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('Template name')).toHaveValue('Duplicate name')
    expect(mockPush).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('renders official content read-only in the details dialog', async () => {
    mockFetch.mockResolvedValue(jsonResponse(templatesPayload))
    render(<TemplateList />)

    fireEvent.click(await screen.findByRole('button', { name: 'View details' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('official-general')
    expect(screen.getByLabelText('Template editor')).toHaveValue('# Weekly report')
    expect(screen.getByLabelText('Template editor')).toHaveAttribute('readonly')
  })

  it('supports personal template selection and deletion', async () => {
    const onSelect = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/templates') return jsonResponse(templatesPayload)
      if (String(input) === '/api/templates/12' && init?.method === 'DELETE') {
        return jsonResponse({ ok: true })
      }
      return jsonResponse({ error: 'Not found' }, false)
    })

    try {
      render(<TemplateList onSelect={onSelect} />)
      fireEvent.click(await screen.findByRole('tab', { name: /Personal templates/ }))
      fireEvent.click(await screen.findByRole('button', { name: 'Use' }))
      expect(onSelect).toHaveBeenCalledWith(templatesPayload.user[0])

      fireEvent.click(screen.getByRole('button', { name: 'Delete template Engineering copy' }))
      await waitFor(() => expect(screen.queryByText('T12')).not.toBeInTheDocument())
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/templates/12',
        expect.objectContaining({ method: 'DELETE' }),
      )
    } finally {
      confirmSpy.mockRestore()
    }
  })
})
