import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import NewTemplatePage from './new/page'
import EditTemplatePage from './[id]/page'

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ id: '8' }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/components/editor/MilkdownEditor', () => ({
  MilkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Template editor" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}))

vi.mock('@/components/StyleSelector', () => ({
  StyleSelector: ({ value, onChange }: { value: string; onChange: (style: string) => void }) => (
    <button type="button" onClick={() => onChange('technical')}>Change {value} to technical</button>
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

const template = {
  id: 8,
  name: 'Engineering weekly',
  content: '# Engineering sections',
  description: 'Engineering report structure',
  tags: 'engineering',
  aiStyle: 'formal',
  sourceTemplateId: null,
}

describe('template pages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  it('creates a template through the existing route and returns to the index', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ template: { id: 9 } }))
    render(<NewTemplatePage />)

    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'New weekly' } })
    fireEvent.change(await screen.findByLabelText('Template editor'), { target: { value: '# Weekly' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A reusable structure' } })
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'weekly' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/templates'))
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/templates',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'New weekly',
          content: '# Weekly',
          description: 'A reusable structure',
          tags: 'weekly',
        }),
      }),
    )
  })

  it('loads and updates a personal template without changing its route', async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/templates/8' && (!init?.method || init.method === 'GET')) {
        return jsonResponse({ template })
      }
      if (String(input) === '/api/templates/8' && init?.method === 'PUT') {
        return jsonResponse({ template })
      }
      return jsonResponse({ error: 'Not found' }, false)
    })
    render(<EditTemplatePage />)

    expect(await screen.findByLabelText('Template name')).toHaveValue('Engineering weekly')
    expect(screen.getByText('T8')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Revised weekly' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/templates'))
    const updateCall = mockFetch.mock.calls.find(
      ([path, init]) => path === '/api/templates/8' && (init as RequestInit)?.method === 'PUT',
    )
    expect(JSON.parse((updateCall?.[1] as RequestInit).body as string)).toMatchObject({
      name: 'Revised weekly',
      content: '# Engineering sections',
      description: 'Engineering report structure',
      tags: 'engineering',
    })
  })

  it('updates only the AI style when the generation style changes', async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/templates/8') return jsonResponse({ template })
      return jsonResponse({ error: 'Not found' }, false)
    })
    render(<EditTemplatePage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Change formal to technical' }))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/templates/8',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ aiStyle: 'technical' }),
        }),
      )
    })
  })

  it('retries a failed template load in place', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ error: 'Template unavailable' }, false))
      .mockResolvedValueOnce(jsonResponse({ template }))
    render(<EditTemplatePage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Template unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading template' }))

    expect(await screen.findByLabelText('Template name')).toHaveValue('Engineering weekly')
    expect(mockPush).not.toHaveBeenCalled()
  })
})
