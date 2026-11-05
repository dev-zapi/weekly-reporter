import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TemplateContentEditor } from './TemplateContentEditor'

vi.mock('@/components/editor/MilkdownEditor', () => ({
  MilkdownEditor: () => <div className="ProseMirror" contentEditable role="textbox" />,
}))

describe('TemplateContentEditor', () => {
  it('gives the rich-text editor an accessible name and read-only state', async () => {
    const { rerender } = render(<TemplateContentEditor value="# Report" onChange={vi.fn()} />)

    const editor = await screen.findByRole('textbox', { name: 'Template content' })
    expect(editor).toHaveAttribute('aria-readonly', 'false')

    rerender(<TemplateContentEditor value="# Report" onChange={vi.fn()} readOnly />)
    expect(editor).toHaveAttribute('aria-readonly', 'true')
  })
})
