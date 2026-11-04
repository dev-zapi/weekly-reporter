import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PromptManager } from './PromptManager'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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

const stylesPayload = {
  styles: [
    {
      id: 3,
      key: 'technical',
      label: 'Technical',
      systemPrompt: 'Write an accurate technical report.',
      temperature: '0.4',
      detailLevel: 'medium',
      resultOriented: 'high',
      isDefault: true,
    },
    {
      id: 4,
      key: 'concise',
      label: 'Concise',
      systemPrompt: 'Write a concise report.',
      temperature: '0.2',
      detailLevel: 'low',
      resultOriented: 'medium',
      isDefault: false,
    },
  ],
}

const promptsPayload = {
  prompts: [
    { key: 'check', promptText: 'Saved writing suggestions.' },
    { key: 'score', promptText: 'Saved scoring prompt.' },
  ],
}

function routeConfiguration() {
  mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    const method = init?.method || 'GET'
    if (path === '/api/prompts/styles' && method === 'GET') return jsonResponse(stylesPayload)
    if (path === '/api/prompts/styles' && method === 'POST') return jsonResponse({ ok: true })
    if (path === '/api/prompts/styles/3' && method === 'PUT') return jsonResponse({ ok: true })
    if (path === '/api/prompts/styles/4' && method === 'PATCH') return jsonResponse({ ok: true })
    if (path === '/api/prompts/styles/4' && method === 'DELETE') return jsonResponse({ ok: true })
    if (path === '/api/prompts/system' && method === 'GET') return jsonResponse(promptsPayload)
    if (path === '/api/prompts/system' && method === 'PUT') return jsonResponse({ ok: true })
    return jsonResponse({ error: 'Not found' }, false)
  })
}

describe('PromptManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  it('renders numbered AI styles and updates them through the existing endpoint', async () => {
    routeConfiguration()
    render(<PromptManager />)

    expect(await screen.findByText('S3')).toBeInTheDocument()
    expect(screen.getByText('Technical')).toBeInTheDocument()
    expect(screen.getByText('Default')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit style Technical' }))
    const nameInput = await screen.findByLabelText('Name')
    fireEvent.change(nameInput, { target: { value: 'Technical revised' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/prompts/styles/3',
        expect.objectContaining({ method: 'PUT' }),
      )
    })
    const updateCall = mockFetch.mock.calls.find(
      ([path, init]) => path === '/api/prompts/styles/3' && (init as RequestInit)?.method === 'PUT',
    )
    expect(JSON.parse((updateCall?.[1] as RequestInit).body as string)).toMatchObject({
      key: 'technical',
      label: 'Technical revised',
      detailLevel: 'medium',
      resultOriented: 'high',
    })
  })

  it('edits and saves system prompts without changing the prompt key', async () => {
    routeConfiguration()
    render(<PromptManager />)

    fireEvent.click(await screen.findByRole('tab', { name: 'System prompts' }))
    expect(await screen.findByText('Saved writing suggestions.')).toBeInTheDocument()
    expect(screen.getByText('Saved scoring prompt.')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
    const textarea = screen.getByLabelText('Writing suggestions prompt text')
    fireEvent.change(textarea, { target: { value: 'Revised writing suggestions.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/prompts/system',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ key: 'check', promptText: 'Revised writing suggestions.' }),
        }),
      )
    })
  })

  it('offers a retry when the AI style index cannot be loaded', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ error: 'Unavailable' }, false))
      .mockResolvedValueOnce(jsonResponse(stylesPayload))

    render(<PromptManager />)

    expect(await screen.findByRole('alert')).toHaveTextContent('AI styles could not be loaded')
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading styles' }))
    expect(await screen.findByText('S3')).toBeInTheDocument()
  })

  it('creates a style with the existing validation fields and generation parameters', async () => {
    routeConfiguration()
    render(<PromptManager />)

    fireEvent.click(await screen.findByRole('button', { name: 'New style' }))
    fireEvent.change(screen.getByLabelText('Identifier (key)'), { target: { value: 'plain-language' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Plain language' } })
    fireEvent.change(screen.getByLabelText('System Prompt'), {
      target: { value: 'Use direct, plain language.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Advanced parameters' }))
    const temperature = screen.getByLabelText(/Temperature/)
    fireEvent.change(temperature, { target: { value: '0.7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/prompts/styles',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    const createCall = mockFetch.mock.calls.find(
      ([path, init]) => path === '/api/prompts/styles' && (init as RequestInit)?.method === 'POST',
    )
    expect(JSON.parse((createCall?.[1] as RequestInit).body as string)).toMatchObject({
      key: 'plain-language',
      label: 'Plain language',
      systemPrompt: 'Use direct, plain language.',
      temperature: 0.7,
      detailLevel: 'medium',
      resultOriented: 'medium',
      isDefault: false,
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('sets a default style and deletes a style after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    routeConfiguration()

    try {
      render(<PromptManager />)
      fireEvent.click(await screen.findByRole('button', { name: 'Set Concise as default' }))
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/prompts/styles/4',
          expect.objectContaining({ method: 'PATCH' }),
        )
      })

      fireEvent.click(screen.getByRole('button', { name: 'Delete style Concise' }))
      expect(confirmSpy).toHaveBeenCalledWith('Delete style “Concise”?')
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/prompts/styles/4',
          expect.objectContaining({ method: 'DELETE' }),
        )
      })
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('resets a system prompt to its default before saving', async () => {
    routeConfiguration()
    render(<PromptManager />)

    fireEvent.click(await screen.findByRole('tab', { name: 'System prompts' }))
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0])
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    expect(screen.getByLabelText('Writing suggestions prompt text')).toHaveDisplayValue(
      /You are a weekly report writing assistant/,
    )
  })
})
