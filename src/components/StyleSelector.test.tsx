import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StyleSelector } from './StyleSelector'

const mockStylesResponse = {
  styles: [
    {
      id: 1, key: 'formal', label: '正式汇报',
      systemPrompt: '你是专业的职场周报润色助手，表达正式严谨，突出成果价值。',
      temperature: '0.3', scoreStructureWeight: 25, scoreContentWeight: 30,
      scoreValueWeight: 45, isDefault: true,
      detailLevel: null, resultOriented: null,
      createdAt: new Date(), updatedAt: new Date(),
    },
    {
      id: 2, key: 'technical', label: '技术研发',
      systemPrompt: '你是技术研发周报助手，表述专业准确，保留技术细节。',
      temperature: '0.4', scoreStructureWeight: 20, scoreContentWeight: 50,
      scoreValueWeight: 30, isDefault: false,
      detailLevel: null, resultOriented: null,
      createdAt: new Date(), updatedAt: new Date(),
    },
    {
      id: 3, key: 'concise', label: '极简干练',
      systemPrompt: '你是精简周报助手，用短句表达，去掉冗余修饰。',
      temperature: '0.2', scoreStructureWeight: 40, scoreContentWeight: 30,
      scoreValueWeight: 30, isDefault: false,
      detailLevel: null, resultOriented: null,
      createdAt: new Date(), updatedAt: new Date(),
    },
    {
      id: 4, key: 'detailed', label: '深度复盘',
      systemPrompt: '你是个人工作复盘助手，侧重问题分析与经验沉淀。',
      temperature: '0.5', scoreStructureWeight: 20, scoreContentWeight: 55,
      scoreValueWeight: 25, isDefault: false,
      detailLevel: null, resultOriented: null,
      createdAt: new Date(), updatedAt: new Date(),
    },
  ],
}

const mockFetch = vi.fn()
global.fetch = mockFetch

function mockStylesFetch() {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(mockStylesResponse),
  })
}

describe('StyleSelector', () => {
  const mockOnChange = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    mockStylesFetch()
  })

  describe('Basic Rendering', () => {
    it('should render style selector', async () => {
      render(<StyleSelector onChange={mockOnChange} />)

      expect(screen.getByText('AI style')).toBeInTheDocument()

      await waitFor(() => {
        // Should show the current style key in the trigger
        expect(screen.getByText('formal')).toBeInTheDocument()
      })
    })

    it('should render with controlled value', async () => {
      render(<StyleSelector value="technical" onChange={mockOnChange} />)

      await waitFor(() => {
        expect(screen.getByText('technical')).toBeInTheDocument()
      })
    })
  })

  describe('Style Selection', () => {
    it('should render different styles when value prop changes', async () => {
      const { rerender } = render(<StyleSelector value="formal" onChange={mockOnChange} />)
      await waitFor(() => { expect(screen.getByText('formal')).toBeInTheDocument() })

      rerender(<StyleSelector value="technical" onChange={mockOnChange} />)
      await waitFor(() => { expect(screen.getByText('technical')).toBeInTheDocument() })

      rerender(<StyleSelector value="concise" onChange={mockOnChange} />)
      await waitFor(() => { expect(screen.getByText('concise')).toBeInTheDocument() })

      rerender(<StyleSelector value="detailed" onChange={mockOnChange} />)
      await waitFor(() => { expect(screen.getByText('detailed')).toBeInTheDocument() })
    })
  })

  describe('Template Integration', () => {
    it('should fetch template style when templateId is provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ template: { aiStyle: 'detailed' } }),
      })

      render(<StyleSelector templateId={1} onChange={mockOnChange} />)

      await waitFor(() => {
        expect(screen.getByText('detailed')).toBeInTheDocument()
      })
    })

    it('should handle template fetch error gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      render(<StyleSelector templateId={1} onChange={mockOnChange} />)

      // Should fall back to first style
      await waitFor(() => {
        expect(screen.getByText('formal')).toBeInTheDocument()
      })
    })

    it('should use styleOverride over template style', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ template: { aiStyle: 'detailed' } }),
      })

      render(
        <StyleSelector templateId={1} value="technical" onChange={mockOnChange} />
      )

      await waitFor(() => {
        expect(screen.getByText('technical')).toBeInTheDocument()
      })
    })
  })

  describe('Error Handling', () => {
    it('should handle template without aiStyle', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ template: {} }),
      })

      render(<StyleSelector templateId={1} onChange={mockOnChange} />)

      await waitFor(() => {
        expect(screen.getByText('formal')).toBeInTheDocument()
      })
    })

    it('retries a failed style index request', async () => {
      mockFetch.mockReset()
      mockFetch
        .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: 'Unavailable' }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockStylesResponse) })

      render(<StyleSelector onChange={mockOnChange} />)

      expect(await screen.findByRole('alert')).toHaveTextContent('AI styles could not be loaded')
      fireEvent.click(screen.getByRole('button', { name: 'Retry loading styles' }))
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
      expect(screen.getByText('正式汇报')).toBeInTheDocument()
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('announces when no AI styles are configured', async () => {
      mockFetch.mockReset()
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ styles: [] }) })

      render(<StyleSelector onChange={mockOnChange} />)

      expect(await screen.findByText('No AI styles are configured.')).toBeInTheDocument()
      expect(screen.getByRole('combobox', { name: 'AI style' })).toBeDisabled()
    })
  })
})
