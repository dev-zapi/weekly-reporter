import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { TemplateForm } from './TemplateForm'
import type { Template } from '@/lib/db/schema'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/components/editor/MilkdownEditor', () => ({
  MilkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Template editor" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}))

const template = {
  id: 8,
  name: 'Engineering weekly',
  content: '# Engineering sections',
  description: 'Original description',
  tags: 'engineering',
  sourceTemplateId: null,
  aiStyle: 'technical',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
} as Template

describe('TemplateForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('preserves template editing fields and submits the existing payload', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onCancel = vi.fn()
    render(<TemplateForm template={template} onSave={onSave} onCancel={onCancel} />)

    expect(screen.getByLabelText('Template name')).toHaveValue('Engineering weekly')
    expect(await screen.findByLabelText('Template editor')).toHaveValue('# Engineering sections')

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '  Revised description  ' } })
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: '  backend, weekly  ' } })
    fireEvent.change(screen.getByLabelText('Template editor'), { target: { value: '# Revised sections' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        name: 'Engineering weekly',
        content: '# Revised sections',
        description: 'Revised description',
        tags: 'backend, weekly',
      })
    })
    expect(toast.success).toHaveBeenCalledWith('Template saved')
  })

  it('keeps required name and content validation without calling the mutation', () => {
    const onSave = vi.fn()
    render(<TemplateForm onSave={onSave} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSave).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Please enter a template name and content')
  })

  it('restores the submit action after a failed save', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Update failed'))
    render(<TemplateForm template={template} onSave={onSave} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Save failed'))
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })
})
