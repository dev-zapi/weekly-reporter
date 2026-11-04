import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TagFilterPanel } from './TagFilterPanel'

const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof fetch

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response
}

describe('TagFilterPanel', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('names tag actions with the tag they mutate', async () => {
    mockFetch.mockResolvedValue(
      response({
        tags: [
          { name: 'work', count: 3 },
          { name: 'debug', count: 1 },
        ],
      }),
    )

    render(
      <TagFilterPanel
        selectedTags={[]}
        onTagSelect={vi.fn()}
        onClearTags={vi.fn()}
        onTagsChanged={vi.fn()}
        tagsVersion={0}
      />,
    )

    expect(await screen.findByRole('button', { name: 'Rename tag #work' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete tag #work' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rename tag #debug' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete tag #debug' })).toBeInTheDocument()
  })
})
